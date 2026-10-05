import type { Tool } from '@mcp-gateway/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness';

describe('Admin API: tools and virtual servers', () => {
  let h: Harness;
  let admin: string;
  let owner: string;
  let otherOwner: string;
  let tenantId: string;
  let sourceId: string;
  const created: Record<string, Tool> = {};

  const call = (method: string, url: string, token: string, body?: unknown) =>
    h.app.inject({
      method: method as 'GET',
      url: `/admin/v1${url}`,
      headers: { authorization: `Bearer ${token}`, 'x-tenant': 'acme' },
      ...(body === undefined ? {} : { payload: body as object }),
    });

  beforeAll(async () => {
    h = await startHarness();
    admin = await h.adminToken('acme');
    tenantId = (await call('POST', '/tenants', admin, { slug: 'acme', name: 'ACME' })).json().id;
    owner = await h.token({ sub: 'owner-1', roles: ['tool-owner'], tenant: 'acme', groups: ['team-rh'] });
    otherOwner = await h.token({ sub: 'owner-2', roles: ['tool-owner'], tenant: 'acme', groups: ['team-ops'] });
    sourceId = (
      await call('POST', '/sources', admin, {
        name: 'rh',
        openapiUrl: 'http://up.local/openapi.json',
        baseUrl: 'http://up.local',
        ownerTeam: 'team-rh',
      })
    ).json().id;
    const base = { kind: 'openapi' as const, sourceId, ownerTeam: 'team-rh', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } };
    for (const [name, op] of [
      ['rh_colaboradores_list', 'GET /colaboradores'],
      ['rh_colaboradores_get', 'GET /colaboradores/{id}'],
      ['rh_marcacoes_create', 'POST /marcacoes'],
    ] as const) {
      created[name] = await h.services.repos.tools.create(tenantId, {
        ...base,
        name,
        operationKey: op,
        description: `tool ${name}`,
        operationRef: { method: op.split(' ')[0]!, path: op.split(' ')[1]! },
        specHash: 'h1',
      });
    }
    created.removed = await h.services.repos.tools.create(tenantId, {
      ...base,
      name: 'rh_antiga',
      operationKey: 'GET /antiga',
      state: 'removed',
    });
  });
  afterAll(async () => h?.teardown());

  it('tools start disabled and are listed with filters', async () => {
    const all = (await call('GET', '/tools', admin)).json();
    expect(all.total).toBe(4);
    const disabled = (await call('GET', '/tools?state=disabled', owner)).json();
    expect(disabled.items.map((t: { name: string }) => t.name)).toEqual([
      'rh_colaboradores_get',
      'rh_colaboradores_list',
      'rh_marcacoes_create',
    ]);
    expect((await call('GET', `/tools?sourceId=${sourceId}&q=marcacoes`, admin)).json().total).toBe(1);
    expect((await call('GET', '/tools?ownerTeam=team-ops', admin)).json().total).toBe(0);
  });

  it('name, description and schema overrides', async () => {
    const id = created.rh_colaboradores_list!.id;
    // policies match the effective name: only gateway-admin renames
    const ownerRename = await call('PATCH', `/tools/${id}`, owner, { name: 'buscar_colaboradores' });
    expect(ownerRename.statusCode).toBe(403);
    expect(ownerRename.json().message).toBe('only gateway-admin can rename a tool (policies match the name)');
    const res = await call('PATCH', `/tools/${id}`, admin, {
      name: 'buscar_colaboradores',
      description: 'Busca colaboradores',
      inputSchema: { properties: { id: { description: 'Id do colaborador' } } },
    });
    expect(res.statusCode).toBe(200);
    const t = res.json();
    expect(t).toMatchObject({ name: 'buscar_colaboradores', baseName: 'rh_colaboradores_list', description: 'Busca colaboradores' });
    expect(t.inputSchema.properties.id).toEqual({ type: 'string', description: 'Id do colaborador' });

    // search by the effective name
    expect((await call('GET', '/tools?q=buscar', admin)).json().total).toBe(1);

    // conflict with another tool's effective name
    const dup = await call('PATCH', `/tools/${created.rh_colaboradores_get!.id}`, admin, { name: 'buscar_colaboradores' });
    expect(dup.statusCode).toBe(409);

    // null removes the override
    const reset = (await call('PATCH', `/tools/${id}`, owner, { description: null })).json();
    expect(reset.description).toBe('tool rh_colaboradores_list');
    expect(reset.name).toBe('buscar_colaboradores');
  });

  it('the override survives a crawler update', async () => {
    const id = created.rh_colaboradores_list!.id;
    await h.services.repos.tools.update(tenantId, id, { description: 'new generated description', specHash: 'h2', version: 2 }, { diff: { changed: ['description'] } });
    const t = (await call('GET', `/tools/${id}`, admin)).json();
    expect(t.name).toBe('buscar_colaboradores');
    expect(t.version).toBe(2);
    const versions = (await call('GET', `/tools/${id}/versions`, admin)).json().items;
    expect(versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(versions[0].diff).toEqual({ changed: ['description'] });
  });

  it('state transitions are validated and audited', async () => {
    const id = created.rh_colaboradores_get!.id;
    expect((await call('POST', `/tools/${id}/enable`, owner)).json().state).toBe('enabled');
    expect((await call('POST', `/tools/${id}/enable`, owner)).statusCode).toBe(400);
    expect((await call('POST', `/tools/${id}/deprecate`, admin)).json().state).toBe('deprecated');
    expect((await call('POST', `/tools/${id}/disable`, admin)).json().state).toBe('disabled');

    const removed = created.removed!.id;
    const r = await call('POST', `/tools/${removed}/enable`, admin);
    expect(r.statusCode).toBe(400);
    expect(r.json().message).toBe('invalid transition: removed → enabled');

    const events = await h.services.repos.audit.list(tenantId, { toolId: id });
    expect(events.map((e) => [e.action, e.decision, e.details])).toEqual([
      ['tool.disable', 'applied', { from: 'deprecated', to: 'disabled' }],
      ['tool.deprecate', 'applied', { from: 'enabled', to: 'deprecated' }],
      ['tool.enable', 'rejected', { from: 'enabled', to: 'enabled' }],
      ['tool.enable', 'applied', { from: 'disabled', to: 'enabled' }],
    ]);
    expect(events.every((e) => e.subject)).toBe(true);
    expect((await h.services.repos.audit.list(tenantId, { toolId: removed }))[0]?.decision).toBe('rejected');
  });

  it("a tool-owner of another team cannot change the tool; agents cannot read", async () => {
    const id = created.rh_marcacoes_create!.id;
    const denied = await call('POST', `/tools/${id}/enable`, otherOwner);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().message).toBe('only gateway-admin or owners of team team-rh can change this tool');
    expect((await call('PATCH', `/tools/${id}`, otherOwner, { description: 'x' })).statusCode).toBe(403);
    const agent = await h.token({ roles: ['agent'], tenant: 'acme' });
    expect((await call('GET', '/tools', agent)).statusCode).toBe(403);
  });

  it('virtual server CRUD', async () => {
    const res = await call('POST', '/virtual-servers', owner, {
      slug: 'rh-leitura',
      name: 'RH leitura',
      toolSelector: { patterns: ['rh_colaboradores_*'] },
    });
    expect(res.statusCode).toBe(201);
    const vs = res.json();
    expect((await call('POST', '/virtual-servers', admin, { slug: 'rh-leitura' })).statusCode).toBe(409);
    const patched = (await call('PATCH', `/virtual-servers/${vs.id}`, admin, { description: 'Read only' })).json();
    expect(patched).toMatchObject({ slug: 'rh-leitura', description: 'Read only', toolSelector: { patterns: ['rh_colaboradores_*'] } });
    expect((await call('GET', '/virtual-servers', admin)).json().items).toHaveLength(1);
    expect((await call('DELETE', `/virtual-servers/${vs.id}`, admin)).statusCode).toBe(204);
  });
});

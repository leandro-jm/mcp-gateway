import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorPayload } from '../src/proxy/result';
import { startHarness, type Harness } from './harness';
import { mcpClient, seedRhTenant, type SeededTenant } from './seed';

describe('per-tool projection + _fields (F6.2)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let client: Client;
  let admin: string;
  let owner: string;

  const call = (token: string, method: string, url: string, body?: unknown) =>
    h.app.inject({ method: method as 'GET', url: `/admin/v1${url}`, headers: { authorization: `Bearer ${token}`, 'x-tenant': 'acme' }, ...(body ? { payload: body as object } : {}) });

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream({ colaboradores: 400 });
    seeded = await seedRhTenant(h, up);
    admin = await h.adminToken('acme');
    owner = await h.token({ roles: ['tool-owner'], tenant: 'acme', groups: ['team-rh'] });
    client = await mcpClient(await h.app.listen({ port: 0, host: '127.0.0.1' }), await h.token({ tenant: 'acme' }));
  });
  afterAll(async () => {
    await client?.close();
    await h?.teardown();
    await up?.close();
  });

  const listId = () => seeded.tools.rh_colaboradores_list!;

  it('the owner sets the projection; the response shrinks and the saved bytes go to the audit', async () => {
    const baseline = await client.callTool({ name: 'rh_colaboradores_list', arguments: { size: 400 } });
    const before = JSON.stringify(baseline.structuredContent).length;

    const put = await call(owner, 'PUT', `/tools/${listId()}/projection`, {
      include: ['$.items[*].id', '$.items[*].nome', '$.items[*].cargo', '$.items[*].escala_id', '$.items[*].cpf', '$.total'],
      maxArrayItems: 50,
      allowAgentFields: true,
    });
    expect(put.statusCode).toBe(200);

    const r = await client.callTool({ name: 'rh_colaboradores_list', arguments: { size: 400 } });
    const sc = r.structuredContent as any;
    expect(sc.items).toHaveLength(50);
    expect(Object.keys(sc.items[0]).sort()).toEqual(['cargo', 'cpf', 'escala_id', 'id', 'nome']);
    expect(sc.items[0].cpf).toMatch(/^\*\*\*/); // redaction before projection
    expect(sc.total).toBe(400);
    expect(sc._meta).toEqual({ truncated: true, arrays: { '$.items': { total: 400, returned: 50 } } });
    expect(JSON.stringify(sc).length).toBeLessThan(before / 10);

    const [ev] = await h.services.repos.audit.list(seeded.tenantId, { toolId: listId(), limit: 1 });
    expect(ev!.projectedBytesSaved).toBeGreaterThan(before * 0.8);
  });

  it('_fields is advertised in the input schema and shrinks it further', async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === 'rh_colaboradores_list')!;
    expect((tool.inputSchema.properties as any)._fields).toMatchObject({ type: 'array', description: expect.stringContaining('Optional: fields') });
    const r = await client.callTool({ name: 'rh_colaboradores_list', arguments: { size: 5, _fields: ['id', 'nome'] } });
    expect((r.structuredContent as any).items[0]).toEqual({ id: up.data.colaboradores[0]!.id, nome: up.data.colaboradores[0]!.nome });
    // _fields does not reach the upstream
    expect(up.requests.at(-1)!.url).toBe('/colaboradores?size=5');
  });

  it('_fields never exposes a field outside the projection', async () => {
    const r = await client.callTool({ name: 'rh_colaboradores_list', arguments: { size: 5, _fields: ['id', 'telefone', 'endereco.cidade'] } });
    expect((r.structuredContent as any).items[0]).toEqual({ id: up.data.colaboradores[0]!.id });
  });

  it('_fields is rejected when the projection does not allow it', async () => {
    const r = await client.callTool({ name: 'rh_colaborador_get', arguments: { id: up.data.colaboradores[0]!.id, _fields: ['id'] } });
    expect(errorPayload(r)).toMatchObject({ error: 'VALIDATION_ERROR', message: '_fields is not accepted by this tool' });
  });

  it('preview measures saved bytes; an invalid JSONPath is rejected; another team cannot change it', async () => {
    const payload = { items: up.data.colaboradores.slice(0, 100), total: 100 };
    const prev = (await call(owner, 'POST', `/tools/${listId()}/projection/preview`, { payload })).json();
    expect(prev.bytesSaved).toBeGreaterThan(0);
    expect(prev.ratio).toBeGreaterThan(0.5);
    expect((await call(admin, 'PUT', `/tools/${listId()}/projection`, { include: ['items[*].id'] })).statusCode).toBe(400);
    expect((await call(admin, 'PUT', `/tools/${listId()}/projection`, { include: ['$.items[(@.x)]'] })).statusCode).toBe(400);
    const ops = await h.token({ roles: ['tool-owner'], tenant: 'acme', groups: ['team-ops'] });
    expect((await call(ops, 'PUT', `/tools/${listId()}/projection`, { include: [] })).statusCode).toBe(404);
  });

  it('a suggested projection stays inactive until approved', async () => {
    const id = seeded.tools.rh_marcacoes_list!;
    await h.services.repos.projections.suggest(seeded.tenantId, id, ['$.items[*].id']);
    await h.services.registry.invalidate(seeded.tenantId);
    const r1 = await client.callTool({ name: 'rh_marcacoes_list', arguments: { limit: 3 } });
    expect(Object.keys((r1.structuredContent as any).items[0]).length).toBeGreaterThan(1);
    expect((await call(owner, 'POST', `/tools/${id}/projection/approve`)).json().status).toBe('active');
    const r2 = await client.callTool({ name: 'rh_marcacoes_list', arguments: { limit: 3 } });
    expect(Object.keys((r2.structuredContent as any).items[0])).toEqual(['id']);
  });
});

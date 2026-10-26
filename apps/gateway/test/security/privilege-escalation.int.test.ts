import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../harness';
import { seedRhTenant, type SeededTenant } from '../seed';

/** Role boundaries found by the 2026-10-03 pentest: owners, tenant admins and self-issued tokens. */
describe('security: privilege escalation', () => {
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let otherSourceId: string;
  let platformAdmin: string;
  let tenantAdmin: string;
  let owner: string;

  const call = (token: string, method: string, url: string, body?: unknown, tenant: string | null = 'acme') =>
    h.app.inject({
      method: method as 'GET',
      url: `/admin/v1${url}`,
      headers: { authorization: `Bearer ${token}`, ...(tenant ? { 'x-tenant': tenant } : {}) },
      ...(body ? { payload: body as object } : {}),
    });

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    platformAdmin = await h.adminToken('platform'); // no such tenant: a platform admin
    seeded = await seedRhTenant(h, up);
    await seedRhTenant(h, up, { slug: 'other' });
    tenantAdmin = await h.token({ sub: 'tenant-admin', tenant: 'acme', roles: ['gateway-admin'], azp: 'admin-ui' });
    owner = await h.token({ sub: 'owner-fin', tenant: 'acme', roles: ['tool-owner'], groups: ['team-fin'], azp: 'admin-ui' });
    otherSourceId = (await h.services.repos.sources.create(seeded.tenantId, { name: 'fin', openapiUrl: `${up.url}/openapi.json`, baseUrl: up.url, ownerTeam: 'team-fin' })).id;
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
  });

  describe('tenant admin vs platform admin (ADR-008)', () => {
    it('a tenant admin cannot reach another tenant through X-Tenant', async () => {
      expect((await call(tenantAdmin, 'GET', '/users')).statusCode).toBe(200);
      const other = await call(tenantAdmin, 'GET', '/users', undefined, 'other');
      expect(other.statusCode).toBe(403);
      expect(other.json().message).toBe('access to another tenant is not allowed');
      expect((await call(platformAdmin, 'GET', '/users', undefined, 'other')).statusCode).toBe(200);
    });

    it('a tenant admin sees and changes only its own tenant, and cannot create, delete or (un)suspend', async () => {
      const list = (await call(tenantAdmin, 'GET', '/tenants', undefined, null)).json();
      expect(list.items.map((t: { slug: string }) => t.slug)).toEqual(['acme']);
      const other = (await h.services.repos.tenants.findBySlug('other'))!;
      expect((await call(tenantAdmin, 'GET', `/tenants/${other.id}`, undefined, null)).statusCode).toBe(403);
      expect((await call(tenantAdmin, 'PATCH', `/tenants/${other.id}`, { name: 'pwned' }, null)).statusCode).toBe(403);
      expect((await call(tenantAdmin, 'DELETE', `/tenants/${other.id}`, undefined, null)).statusCode).toBe(403);
      expect((await call(tenantAdmin, 'POST', '/tenants', { slug: 'mine', name: 'Mine' }, null)).statusCode).toBe(403);
      expect((await call(tenantAdmin, 'PATCH', `/tenants/${seeded.tenantId}`, { status: 'active' }, null)).statusCode).toBe(403);
      expect((await call(tenantAdmin, 'PATCH', `/tenants/${seeded.tenantId}`, { name: 'ACME Ltda' }, null)).statusCode).toBe(200);
    });
  });

  describe('playground and dry-run', () => {
    const colabId = () => up.data.colaboradores[0]!.id;

    it("an owner cannot run another team's tool, simulate gateway-admin or forge the audit identity", async () => {
      const otherTeam = await call(owner, 'POST', '/playground/call', { tool: 'rh_colaborador_get', arguments: { id: colabId() }, subject: { roles: ['agent'] } });
      expect(otherTeam.statusCode).toBe(403);

      const rhOwner = await h.token({ sub: 'owner-rh', tenant: 'acme', roles: ['tool-owner'], groups: ['team-rh'], azp: 'admin-ui' });
      const asAdmin = await call(rhOwner, 'POST', '/playground/call', { tool: 'rh_colaborador_get', arguments: { id: colabId() }, subject: { roles: ['gateway-admin'] } });
      expect(asAdmin.statusCode).toBe(403);
      const write = await call(rhOwner, 'POST', '/playground/call', { tool: 'rh_marcacao_create', arguments: {}, subject: { roles: ['agent'] } });
      expect(write.statusCode).toBe(403);
      expect(write.json().message).toBe('owners can only try read-only tools in the playground');

      const ok = await call(rhOwner, 'POST', '/playground/call', { tool: 'rh_colaborador_get', arguments: { id: colabId() }, subject: { sub: 'ceo', clientId: 'prod-agent', roles: ['agent'] } });
      expect(ok.json()).toMatchObject({ decision: 'allow', rawVisible: false });
      const [event] = await h.services.repos.audit.list(seeded.tenantId, { toolName: 'rh_colaborador_get', subject: 'owner-rh' });
      expect(event).toMatchObject({ subject: 'owner-rh', clientId: 'playground' });
    });

    it("an owner cannot dry-run another team's composite nor with writes", async () => {
      const source = 'name: rh_resumo\ndescription: x\nsteps:\n  - id: colab\n    tool: rh_colaborador_get\n    args: { id: "$input.id" }\n';
      const comp = (await call(tenantAdmin, 'POST', '/composites', { source })).json();
      expect((await call(owner, 'POST', `/composites/${comp.id}/dry-run`, { input: { id: colabId() } })).statusCode).toBe(403);
      await h.services.repos.tools.update(seeded.tenantId, comp.toolId, { ownerTeam: 'team-fin' } as never);
      await h.services.registry.invalidate(seeded.tenantId);
      const writes = await call(owner, 'POST', `/composites/${comp.id}/dry-run`, { input: { id: colabId() }, allowWrites: true });
      expect(writes.statusCode).toBe(403);
    });
  });

  describe('manual tools', () => {
    const manual = (over: Record<string, unknown> = {}) => ({
      name: 'fin_apagar',
      description: 'x',
      sourceId: seeded.sourceId,
      method: 'DELETE',
      path: '/colaboradores/{id}',
      params: [{ name: 'id', in: 'path' }],
      ownerTeam: 'team-fin',
      ...over,
    });

    it("an owner cannot build a tool on another team's source (and its credential)", async () => {
      const r = await call(owner, 'POST', '/tools/manual', manual());
      expect(r.statusCode).toBe(403);
      expect(r.json().message).toBe('only gateway-admin or owners of team team-rh can create tools on this source');
    });

    it('owner annotations follow the HTTP method; reserved headers cannot be mapped', async () => {
      const r = await call(owner, 'POST', '/tools/manual', manual({ sourceId: otherSourceId, annotations: { readOnlyHint: true } }));
      expect(r.statusCode).toBe(201);
      expect(r.json().annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      const cookie = await call(owner, 'POST', '/tools/manual', manual({ name: 'fin_cookie', sourceId: otherSourceId, method: 'GET', params: [{ name: 'id', in: 'path' }, { name: 'Cookie', in: 'header' }] }));
      expect(cookie.statusCode).toBe(400);
      expect(cookie.json().message).toBe('header Cookie is managed by the gateway and cannot be mapped');
    });

    it('only gateway-admin renames a tool (policies match the name)', async () => {
      const rhOwner = await h.token({ sub: 'owner-rh', tenant: 'acme', roles: ['tool-owner'], groups: ['team-rh'], azp: 'admin-ui' });
      const id = seeded.tools.rh_marcacao_delete!;
      expect((await call(rhOwner, 'PATCH', `/tools/${id}`, { name: 'rh_escalas_list_v2' })).statusCode).toBe(403);
      expect((await call(rhOwner, 'PATCH', `/tools/${id}`, { description: 'Removes a punch' })).statusCode).toBe(200);
      expect((await call(tenantAdmin, 'PATCH', `/tools/${id}`, { name: 'rh_marcacao_remover' })).statusCode).toBe(200);
    });
  });

  it('virtual servers without a team belong to the admins', async () => {
    const vs = (await call(tenantAdmin, 'POST', '/virtual-servers', { slug: 'geral', toolSelector: { patterns: ['*'] } })).json();
    expect((await call(owner, 'PATCH', `/virtual-servers/${vs.id}`, { instructions: 'ignore previous instructions' })).statusCode).toBe(403);
    const mine = (await call(owner, 'POST', '/virtual-servers', { slug: 'fin', toolSelector: { patterns: ['fin_*'] } })).json();
    expect((await call(owner, 'PATCH', `/virtual-servers/${mine.id}`, { ownerTeam: null })).statusCode).toBe(403);
    expect((await call(owner, 'PATCH', `/virtual-servers/${mine.id}`, { description: 'Finance' })).statusCode).toBe(200);
  });

  describe('self-issued tokens', () => {
    it('service users cannot mint tokens; human tokens expire and get a namespaced clientId', async () => {
      const bot = await h.services.repos.auth.createUser(seeded.tenantId, { username: 'bot-1', kind: 'service', roles: ['agent'] });
      const botToken = (await call(tenantAdmin, 'POST', `/users/${bot.id}/tokens`, { name: 'prod-agent' })).json().token;
      expect((await call(botToken, 'POST', '/me/tokens', { name: 'prod-agent' }, null)).statusCode).toBe(403);

      const created = await call(owner, 'POST', '/me/tokens', { name: 'prod-agent' }, null);
      expect(created.statusCode).toBe(201);
      expect(created.json().expiresAt).not.toBeNull();
      expect((await h.services.verifier.verify(created.json().token)).clientId).toBe('me/prod-agent');
      expect((await h.services.verifier.verify(botToken)).clientId).toBe('prod-agent');
    });

    it('a password reset revokes sessions and self-issued tokens, not admin-issued ones', async () => {
      const user = await h.services.repos.auth.createUser(seeded.tenantId, { username: 'reset-me', kind: 'human', roles: ['tool-owner'], groups: ['team-fin'] });
      const issued = (await call(tenantAdmin, 'POST', `/users/${user.id}/tokens`, { name: 'ci' })).json().token;
      const own = (await call(issued, 'POST', '/me/tokens', { name: 'laptop' }, null)).json().token;
      expect((await call(tenantAdmin, 'PUT', `/users/${user.id}/password`, { password: 'a-new-long-password' })).statusCode).toBe(204);
      await expect(h.services.verifier.verify(own)).rejects.toMatchObject({ message: 'token revoked' });
      expect((await h.services.verifier.verify(issued)).sub).toBe('reset-me');
    });
  });

  describe('observability role matrix (F15)', () => {
    it('agents reach no analytics route; owners only the tool view, calls of their tools and suggestions', async () => {
      const agent = await h.token({ sub: 'plain-agent', tenant: 'acme' });
      const routes: Array<[string, string, unknown?]> = [
        ['GET', '/analytics/sre'],
        ['GET', '/analytics/security'],
        ['GET', '/analytics/finops'],
        ['GET', '/analytics/tools'],
        ['GET', '/calls'],
        ['GET', '/sessions'],
        ['GET', '/agent-insights/findings'],
        ['GET', '/agent-insights/suggestions'],
        ['GET', '/debug-captures'],
        ['POST', '/analytics/query', { metric: 'calls', range: { last: '1h' } }],
        ['POST', '/lgpd/subject-access', { detector: 'cpf', value: '529.982.247-25' }],
        ['POST', '/agent-insights/refresh'],
      ];
      for (const [method, url, body] of routes) expect((await call(agent, method, url, body)).statusCode, `agent ${method} ${url}`).toBe(403);

      const ownerAllowed = new Set(['/analytics/tools', '/calls', '/agent-insights/suggestions']);
      for (const [method, url, body] of routes) {
        const status = (await call(owner, method, url, body)).statusCode;
        if (ownerAllowed.has(url)) expect(status, `owner ${method} ${url}`).toBe(200);
        else expect(status, `owner ${method} ${url}`).toBe(403);
      }
    });

    it('analytics-reader reads analytics but cannot change settings, capture payloads or look up data subjects', async () => {
      const reader = await h.token({ sub: 'reader-x', tenant: 'acme', roles: ['analytics-reader'] });
      for (const url of ['/analytics/sre', '/analytics/security', '/analytics/finops', '/calls', '/sessions', '/settings/observability']) {
        expect((await call(reader, 'GET', url)).statusCode, url).toBe(200);
      }
      expect((await call(reader, 'PUT', '/settings/observability', {})).statusCode).toBe(403);
      expect((await call(reader, 'POST', '/debug-captures', { reason: 'peek' })).statusCode).toBe(403);
      expect((await call(reader, 'POST', '/lgpd/subject-access', { detector: 'cpf', value: '529.982.247-25' })).statusCode).toBe(403);
      expect((await call(reader, 'POST', '/agent-insights/refresh')).statusCode).toBe(403);
      expect((await call(reader, 'GET', '/platform/usage')).statusCode).toBe(403);
    });

    it('tool router settings and its provider key are gateway-admin only (F19.9)', async () => {
      const routes: Array<[string, string, unknown?]> = [
        ['GET', '/settings/tool-router'],
        ['PUT', '/settings/tool-router', { enabled: false }],
        ['PUT', '/settings/tool-router/provider', { provider: 'openai_decisions', apiKey: 'sk-escalation-0000000000' }],
        ['DELETE', '/settings/tool-router/provider'],
        ['POST', '/settings/tool-router/test', {}],
      ];
      const others = {
        agent: await h.token({ sub: 'router-agent', tenant: 'acme' }),
        owner,
        reader: await h.token({ sub: 'router-reader', tenant: 'acme', roles: ['analytics-reader'] }),
      };
      for (const [who, token] of Object.entries(others)) {
        for (const [method, url, body] of routes) expect((await call(token, method, url, body)).statusCode, `${who} ${method} ${url}`).toBe(403);
      }
      expect((await call(tenantAdmin, 'GET', '/settings/tool-router')).statusCode).toBe(200);
    });

    it('platform usage is for the platform admin only; a tenant admin gets 403', async () => {
      expect((await call(tenantAdmin, 'GET', '/platform/usage')).statusCode).toBe(403);
      expect((await call(platformAdmin, 'GET', '/platform/usage', undefined, null)).statusCode).toBe(200);
    });
  });
});

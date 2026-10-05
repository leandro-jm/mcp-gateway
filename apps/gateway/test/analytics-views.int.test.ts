import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintToken, startHarness, type Harness } from './harness';
import { mcpClient, seedRhTenant, type SeededTenant } from './seed';

describe('analytics views per audience (F15.12)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let admin: string;

  const get = (url: string, token = admin) => h.app.inject({ method: 'GET', url: `/admin/v1${url}`, headers: { authorization: `Bearer ${token}`, 'x-tenant': 'acme' } });

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    seeded = await seedRhTenant(h, up, { enable: ['rh_colaboradores_list', 'rh_colaborador_get', 'rh_escalas_list'] });
    await h.services.repos.projections.upsert(seeded.tenantId, seeded.tools.rh_colaboradores_list!, { include: ['$.items[*].id', '$.total'] });
    await h.services.registry.invalidate(seeded.tenantId);
    const base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    const agent = await mcpClient(base, await h.token({ tenant: 'acme', sub: 'agent-v', azp: 'bot-v' }));
    const viewer = await mcpClient(base, await h.token({ tenant: 'acme', sub: 'viewer-v', roles: ['viewer'] }));
    try {
      for (let i = 0; i < 3; i++) await agent.callTool({ name: 'rh_colaboradores_list', arguments: { size: 20 } });
      await agent.callTool({ name: 'rh_colaborador_get', arguments: { id: up.data.colaboradores[0]!.id } });
      await agent.callTool({ name: 'rh_colaborador_get', arguments: { id: 'missing' } });
      await agent.callTool({ name: 'rh_colaborador_get', arguments: { nope: true } });
      await viewer.callTool({ name: 'rh_colaborador_get', arguments: { id: 'x' } }).catch(() => undefined);
    } finally {
      await agent.close();
      await viewer.close();
    }
    await h.services.callEvents.flush();
    await h.services.repos.rollups.rollup();
    admin = await h.adminToken('acme');
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
  });

  it('SRE: totals, overhead vs upstream over time, errors per source and stage, stage averages', async () => {
    const res = await get('/analytics/sre?last=24h');
    expect(res.statusCode).toBe(200);
    const v = res.json();
    expect(v.totals.calls).toBe(7); // the viewer's deny counts as a call
    expect(v.totals.overheadP95).toBeGreaterThan(0);
    expect(v.overTime.length).toBeGreaterThan(0);
    expect(v.overTime[0]).toMatchObject({ ts: expect.any(String), calls: expect.any(Number) });
    expect(v.errorsBySource).toEqual([{ source: 'rh', calls: 1 }]);
    expect(v.errorsByStage.map((x: { stage: string }) => x.stage).sort()).toEqual(['protocol', 'upstream', 'validation']);
    expect(v.stages.upstream).toBeGreaterThan(0);
  });

  it('tools: usage per tool and agent, validation errors, never-used tools; owners see only their tools', async () => {
    const v = (await get('/analytics/tools?last=24h')).json();
    const get1 = v.usage.find((u: { tool: string }) => u.tool === 'rh_colaborador_get');
    expect(get1).toMatchObject({ calls: 4, errors: 2, agents: 1, validationErrors: 1 });
    expect(v.neverUsed.map((n: { tool: string }) => n.tool)).toEqual(['rh_escalas_list']);
    expect(v.byAgent.some((b: { agent: string }) => b.agent === 'test')).toBe(true);

    const ownerRh = await h.token({ tenant: 'acme', sub: 'owner-rh', roles: ['tool-owner'], groups: ['team-rh'] });
    expect((await get('/analytics/tools?last=24h', ownerRh)).json().usage.length).toBeGreaterThan(0);
    const ownerOther = await h.token({ tenant: 'acme', sub: 'owner-other', roles: ['tool-owner'], groups: ['team-x'] });
    const other = (await get('/analytics/tools?last=24h', ownerOther)).json();
    expect(other.usage).toEqual([]);
    expect(other.neverUsed).toEqual([]);
    expect((await get('/analytics/sre', ownerRh)).statusCode).toBe(403);
  });

  it('security: denials by tool and rule, redactions per detector, reserved lists empty', async () => {
    const v = (await get('/analytics/security?last=24h')).json();
    expect(v.denials).toEqual([{ tool: 'rh_colaborador_get', calls: 1 }]);
    expect(v.denialsByRule[0]).toMatchObject({ reason: 'default_deny', tool: 'rh_colaborador_get', calls: 1 });
    expect(v.redactionsByDetector.cpf).toBeGreaterThan(0);
    expect(v).toMatchObject({ confirms: [], blockedFlows: [], pinningViolations: [], anomalies: [] });
  });

  it('FinOps: tokens saved in money with the tenant price, before/after card and chargeback', async () => {
    const put = await h.app.inject({
      method: 'PUT',
      url: '/admin/v1/settings/observability',
      headers: { authorization: `Bearer ${admin}`, 'x-tenant': 'acme' },
      payload: { pricing: { currency: 'USD', inputPerMTok: 3 } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ pricing: { currency: 'USD', inputPerMTok: 3 }, issueSessionId: true, outcomeTool: 'omni' });
    const v = (await get('/analytics/finops?last=24h')).json();
    expect(v.pricing).toEqual({ currency: 'USD', inputPerMTok: 3 });
    expect(v.tokens.savedByMechanism.projection).toBeGreaterThan(0);
    expect(v.beforeAfter.withoutGateway).toBeGreaterThan(v.beforeAfter.withGateway);
    expect(v.beforeAfter.savedPct).toBeGreaterThan(0);
    expect(v.usageByClient.find((u: { key: string }) => u.key === 'bot-v')).toMatchObject({ calls: 6, errors: 2 });
    expect(v.usageByAgent.find((u: { key: string }) => u.key === 'test')).toBeTruthy();

    const bad = await h.app.inject({ method: 'PUT', url: '/admin/v1/settings/observability', headers: { authorization: `Bearer ${admin}`, 'x-tenant': 'acme' }, payload: { pricing: { currency: 'reais' } } });
    expect(bad.statusCode).toBe(400);
    const reader = await h.token({ tenant: 'acme', sub: 'reader-v', roles: ['analytics-reader'] });
    expect((await h.app.inject({ method: 'PUT', url: '/admin/v1/settings/observability', headers: { authorization: `Bearer ${reader}`, 'x-tenant': 'acme' }, payload: {} })).statusCode).toBe(403);
    expect((await get('/analytics/finops', reader)).statusCode).toBe(200);
  });

  it('platform usage is for the platform admin only; agents get 403 everywhere', async () => {
    expect((await get('/platform/usage?last=24h')).statusCode).toBe(403);
    const platform = await mintToken(h.services, { sub: 'root', roles: ['gateway-admin'], azp: 'admin-ui', tenant: undefined });
    const res = await get('/platform/usage?last=24h', platform);
    expect(res.statusCode).toBe(200);
    expect(res.json().tenants.find((t: { slug: string }) => t.slug === 'acme')).toMatchObject({ calls: 7, errors: 2 });
    const agent = await h.token({ tenant: 'acme' });
    for (const view of ['sre', 'tools', 'security', 'finops']) expect((await get(`/analytics/${view}`, agent)).statusCode).toBe(403);
  });
});

import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAgentAnalytics } from '../src/analytics/job';
import { startHarness, type Harness } from './harness';
import { mcpClient, seedRhTenant, type SeededTenant } from './seed';

describe('agent analytics API (F15.23)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let admin: string;

  const call = (method: string, url: string, body?: unknown, token = admin, tenant = 'acme') =>
    h.app.inject({ method: method as 'GET', url: `/admin/v1${url}`, headers: { authorization: `Bearer ${token}`, 'x-tenant': tenant }, ...(body !== undefined ? { payload: body as object } : {}) });

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    seeded = await seedRhTenant(h, up);
    await seedRhTenant(h, up, { slug: 'other' });
    const base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    const colab = up.data.colaboradores[0]!;
    for (const sub of ['ana', 'bia', 'caio']) {
      const c = await mcpClient(base, await h.token({ tenant: 'acme', sub }), '/mcp/omni');
      try {
        await c.callTool({ name: 'call_tool', arguments: { name: 'rh_colaborador_get', arguments: { id: colab.id } } });
        await c.callTool({ name: 'call_tool', arguments: { name: 'rh_escalas_list', arguments: { colaborador: colab.id } } });
        await c.callTool({ name: 'report_outcome', arguments: { outcome: sub === 'caio' ? 'failure' : 'success' } });
      } finally {
        await c.close();
      }
    }
    await runAgentAnalytics(h.services);
    admin = await h.adminToken('acme');
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
  });

  it('lists sessions and returns a trajectory', async () => {
    const sessions = (await call('GET', '/sessions?last=24h')).json().items as Array<{ sessionKey: string; subject: string; calls: number; agentName: string }>;
    expect(sessions).toHaveLength(3);
    expect(sessions[0]).toMatchObject({ calls: 2, agentName: 'test' });
    const t = (await call('GET', `/sessions/${sessions[0]!.sessionKey}?last=24h`)).json();
    expect(t.segments).toHaveLength(1);
    expect(t.segments[0].events.map((e: { tool: { name: string } }) => e.tool.name)).toEqual(['rh_colaborador_get', 'rh_escalas_list', 'report_outcome']);
    expect((await call('GET', `/sessions/${sessions[0]!.sessionKey}`, undefined, await h.adminToken('other'), 'other')).statusCode).toBe(404);
  });

  it('suggests a composite and accepting creates a disabled draft owned by the team', async () => {
    const { items } = (await call('GET', '/agent-insights/suggestions?status=open')).json();
    const s = items.find((x: { sequence: string[] }) => x.sequence.join() === 'rh_colaborador_get,rh_escalas_list');
    expect(s).toMatchObject({ sessions: 3, subjects: 3, status: 'open' });
    expect(s.draft).toContain('rh_escalas_list');

    const owner = await h.token({ tenant: 'acme', sub: 'owner-a', roles: ['tool-owner'], groups: ['team-rh'] });
    const accepted = await call('POST', `/agent-insights/suggestions/${s.id}/accept`, { name: 'rh_colab_escalas' }, owner);
    expect(accepted.statusCode).toBe(201);
    const { compositeId, toolId } = accepted.json();
    const comp = (await call('GET', `/composites/${compositeId}`, undefined, owner)).json();
    expect(comp).toMatchObject({ name: 'rh_colab_escalas', status: 'draft', state: 'disabled' });
    const tool = (await call('GET', `/tools/${toolId}`, undefined, owner)).json();
    expect(tool).toMatchObject({ kind: 'composite', ownerTeam: 'team-rh', state: 'disabled' });
    const [audit] = await h.services.repos.audit.list(seeded.tenantId, { action: 'composite.create', limit: 1 });
    expect(audit).toMatchObject({ subject: 'owner-a', details: { draft: true } });
    expect((await call('POST', `/agent-insights/suggestions/${s.id}/accept`, {}, owner)).statusCode).toBe(409);
    expect((await call('GET', '/agent-insights/suggestions?status=accepted')).json().items[0]).toMatchObject({ id: s.id, compositeId });
  });

  it('dismiss, findings, co-usage and outcomes', async () => {
    const { items } = (await call('GET', '/agent-insights/suggestions?status=open')).json();
    for (const s of items) expect((await call('POST', `/agent-insights/suggestions/${s.id}/dismiss`)).json().status).toBe('dismissed');
    expect((await call('GET', '/agent-insights/findings?last=24h')).statusCode).toBe(200);
    const co = (await call('GET', '/analytics/co-usage?last=24h')).json();
    expect(co.edges).toEqual(expect.arrayContaining([{ from: 'rh_colaborador_get', to: 'rh_escalas_list', count: 3 }]));
    expect(co.nodes).toEqual(expect.arrayContaining(['rh_colaborador_get', 'rh_escalas_list']));
    const out = (await call('GET', '/analytics/outcomes?last=24h')).json();
    expect(out.totals).toEqual({ success: 2, failure: 1 });
    expect(out.byTool.find((x: { tool: string }) => x.tool === 'rh_escalas_list').successRate).toBeCloseTo(0.667, 2);
  });

  it('agents cannot read it; owners cannot see sessions', async () => {
    expect((await call('GET', '/sessions', undefined, await h.token({ tenant: 'acme' }))).statusCode).toBe(403);
    const owner = await h.token({ tenant: 'acme', sub: 'owner-b', roles: ['tool-owner'], groups: ['team-rh'] });
    expect((await call('GET', '/sessions', undefined, owner)).statusCode).toBe(403);
  });
});

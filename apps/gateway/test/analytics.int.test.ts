import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness';
import { mcpClient, seedRhTenant, type SeededTenant } from './seed';

describe('analytics query API (F15.9)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let admin: string;
  let reader: string;

  const query = (body: unknown, token = admin) =>
    h.app.inject({ method: 'POST', url: '/admin/v1/analytics/query', headers: { authorization: `Bearer ${token}`, 'x-tenant': 'acme' }, payload: body as object });

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    seeded = await seedRhTenant(h, up);
    const other = await seedRhTenant(h, up, { slug: 'other' });
    const base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    const agent = await mcpClient(base, await h.token({ tenant: 'acme', sub: 'agent-a', azp: 'bot-a' }));
    const otherAgent = await mcpClient(base, await h.token({ tenant: 'other', sub: 'agent-z' }));
    try {
      for (let i = 0; i < 4; i++) await agent.callTool({ name: 'rh_colaboradores_list', arguments: { size: 5 } });
      await agent.callTool({ name: 'rh_colaborador_get', arguments: { id: up.data.colaboradores[0]!.id } });
      await agent.callTool({ name: 'rh_colaborador_get', arguments: { id: 'missing' } });
      for (let i = 0; i < 7; i++) await otherAgent.callTool({ name: 'rh_colaboradores_list', arguments: { size: 1 } });
    } finally {
      await agent.close();
      await otherAgent.close();
    }
    expect(other.tenantId).not.toBe(seeded.tenantId);
    await h.services.callEvents.flush();
    await h.services.repos.rollups.rollup();
    admin = await h.adminToken('acme');
    reader = await h.token({ tenant: 'acme', sub: 'analyst', roles: ['analytics-reader'] });
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
  });

  it('counts calls per tool for the tenant only', async () => {
    const res = await query({ metric: 'calls', groupBy: ['tool'], range: { last: '1h' } });
    expect(res.statusCode).toBe(200);
    const rows = res.json().rows as Array<{ keys: { tool: string }; value: number }>;
    expect(rows).toEqual([
      { keys: { tool: 'rh_colaboradores_list' }, value: 4 },
      { keys: { tool: 'rh_colaborador_get' }, value: 2 },
    ]);
  });

  it('error rate, percentiles and time buckets', async () => {
    const rate = (await query({ metric: 'error_rate', filters: { tool: 'rh_colaborador_get' }, range: { last: '1h' } })).json();
    expect(rate.rows).toEqual([{ keys: {}, value: 0.5 }]);
    const p95 = (await query({ metric: 'latency_p95', groupBy: ['tool'], range: { last: '24h' } })).json();
    expect(p95.rows.every((r: { value: number }) => r.value > 0)).toBe(true);
    const byHour = (await query({ metric: 'calls', groupBy: ['hour'], range: { last: '24h' } })).json();
    expect(byHour.rows.reduce((a: number, r: { value: number }) => a + r.value, 0)).toBe(6);
    expect(byHour.rows[0].keys.hour).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00/);
    const errors = (await query({ metric: 'calls', groupBy: ['error_code'], filters: { decision: 'error' }, range: { last: '1h' } })).json();
    expect(errors.rows).toEqual([{ keys: { error_code: 'UPSTREAM_CLIENT_ERROR' }, value: 1 }]);
  });

  it('analytics-reader can query; agents and owners cannot', async () => {
    expect((await query({ metric: 'calls', range: { last: '1h' } }, reader)).statusCode).toBe(200);
    expect((await query({ metric: 'calls', range: { last: '1h' } }, await h.token({ tenant: 'acme' }))).statusCode).toBe(403);
    const owner = await h.token({ tenant: 'acme', sub: 'owner-x', roles: ['tool-owner'], groups: ['team-rh'] });
    expect((await query({ metric: 'calls', range: { last: '1h' } }, owner)).statusCode).toBe(403);
  });

  it('invalid queries return localized 400s; SQL-looking values are only parameters', async () => {
    const adminPt = await h.token({ tenant: 'acme', sub: 'admin-pt', roles: ['gateway-admin'], locale: 'pt-BR' });
    const bad = await query({ metric: 'calls; DROP TABLE call_events', range: { last: '1h' } }, adminPt);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/^métrica "calls; DROP TABLE call_events" desconhecida/);
    const injected = await query({ metric: 'calls', filters: { tool: "x' OR '1'='1" }, range: { last: '1h' } });
    expect(injected.statusCode).toBe(200);
    expect(injected.json().rows).toEqual([]);
  });
});

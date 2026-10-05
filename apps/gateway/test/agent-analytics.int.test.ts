import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAgentAnalytics } from '../src/analytics/job';
import { startHarness, type Harness } from './harness';
import { mcpClient, seedRhTenant, type SeededTenant } from './seed';

describe('agent analytics job (F15.21)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    seeded = await seedRhTenant(h, up);
    const base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    const colab = up.data.colaboradores[0]!;
    // three users follow the same path: colaborador → escalas → marcacoes
    for (const sub of ['ana', 'bia', 'caio']) {
      const c = await mcpClient(base, await h.token({ tenant: 'acme', sub }));
      try {
        await c.callTool({ name: 'rh_colaborador_get', arguments: { id: colab.id } });
        await c.callTool({ name: 'rh_escalas_list', arguments: { colaborador: colab.id } });
        await c.callTool({ name: 'rh_marcacoes_list', arguments: { colaborador: colab.id } });
      } finally {
        await c.close();
      }
    }
    // one agent loops on the same call
    const looper = await mcpClient(base, await h.token({ tenant: 'acme', sub: 'loopy' }));
    try {
      for (let i = 0; i < 4; i++) await looper.callTool({ name: 'rh_colaborador_get', arguments: { id: 'missing' } });
    } finally {
      await looper.close();
    }
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
  });

  it('stores findings, co-usage and an open composite suggestion', async () => {
    const r = await runAgentAnalytics(h.services);
    expect(r).toMatchObject({ skipped: false, tenants: 1 });
    const findings = await h.services.repos.agentAnalytics.findings(seeded.tenantId);
    expect(findings).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'loop', tool: 'rh_colaborador_get', subject: 'loopy', count: 4 })]));
    expect(findings).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'abandoned', tool: 'rh_colaborador_get', subject: 'loopy' })]));
    const [suggestion] = await h.services.repos.agentAnalytics.suggestions(seeded.tenantId, 'open');
    expect(suggestion).toMatchObject({ sequence: ['rh_colaborador_get', 'rh_escalas_list', 'rh_marcacoes_list'], sessions: 3, subjects: 3, status: 'open' });
    const day = new Date().toISOString().slice(0, 10);
    expect(await h.services.repos.agentAnalytics.coUsage(seeded.tenantId, day, day)).toEqual(
      expect.arrayContaining([{ from: 'rh_colaborador_get', to: 'rh_escalas_list', count: 3 }]),
    );
  });

  it('reruns do not duplicate and a dismissed suggestion stays dismissed', async () => {
    const before = (await h.services.repos.agentAnalytics.findings(seeded.tenantId)).length;
    const [s] = await h.services.repos.agentAnalytics.suggestions(seeded.tenantId, 'open');
    await h.services.repos.agentAnalytics.setSuggestionStatus(seeded.tenantId, s!.id, 'dismissed');
    await runAgentAnalytics(h.services);
    expect((await h.services.repos.agentAnalytics.findings(seeded.tenantId)).length).toBe(before);
    expect(await h.services.repos.agentAnalytics.suggestions(seeded.tenantId, 'open')).toEqual([]);
    expect((await h.services.repos.agentAnalytics.suggestion(seeded.tenantId, s!.id))!.status).toBe('dismissed');
  });

  it('a second runner skips while the lease is held', async () => {
    await h.services.redis.set('mcp-gw:agent-analytics:lock', 'other', 'PX', 5000);
    try {
      expect((await runAgentAnalytics(h.services)).skipped).toBe(true);
    } finally {
      await h.services.redis.del('mcp-gw:agent-analytics:lock');
    }
  });
});

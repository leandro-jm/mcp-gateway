import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeDecisions } from './fake-decisions';
import { startHarness, type Harness } from './harness';
import { optionTool, routerEvents, seedSyntheticTenant, setProvider, setRouter } from './router-helpers';
import { mcpClient } from './seed';

const CPF = '529.982.247-25';
const names = (r: any) => (r.structuredContent as { results: Array<{ name: string }> }).results.map((x) => x.name);

describe('tool router: rerank on search_tools (F19.6)', () => {
  let h: Harness;
  let base: string;
  let tenantId: string;
  let token: string;
  const fake = new FakeDecisions();
  const clients: Client[] = [];

  beforeAll(async () => {
    h = await startHarness({ env: { TOOL_ROUTER_ENABLED: 'true' }, decisions: fake.factory });
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    tenantId = await seedSyntheticTenant(h, 'acme');
    await setProvider(h, tenantId);
    await setRouter(h, tenantId, { enabled: true, rerank: { candidates: 10 } });
    token = await h.token({ tenant: 'acme', sub: 'agente-router' });
  });
  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => undefined);
    await h?.teardown();
  });
  beforeEach(() => fake.reset());

  const omni = async (tk = token) => {
    const c = await mcpClient(base, tk, '/mcp/omni');
    clients.push(c);
    return c;
  };
  const search = async (c: Client, query: string, limit = 3) => names(await c.callTool({ name: 'search_tools', arguments: { query, limit } }));
  const baseline = async (query: string, limit: number, allowed?: (n: string) => boolean) => {
    const snap = await h.services.registry.get(tenantId);
    const pool = snap.tools.filter((t) => !allowed || allowed(t.name));
    return (await h.services.search.search(tenantId, query, pool, limit)).map((r) => r.tool.name);
  };

  it('moves the candidate chosen by the decision model to the top', async () => {
    let chosen: string | undefined;
    fake.answer({
      tool: (req) => {
        chosen = optionTool(req, 't3');
        return { type: 'choice', choice: 't3', probabilities: { t3: 0.85 }, confidence: 0.85 };
      },
    });
    const c = await omni();
    const query = 'quando o colaborador vai tirar férias? cpf ' + CPF;
    const got = await search(c, query);
    const fts = await baseline(query, 10);
    expect(chosen).toBe(fts[2]);
    expect(got).toEqual([fts[2], fts[0], fts[1]]);

    // the request carried 10 candidates and no clear-text PII
    const q = fake.requests[0]!.questions[0]!;
    expect(q.type === 'choice' && q.choices).toHaveLength(11);
    expect(fake.requests[0]!.input).not.toContain(CPF);

    const [ev] = (await routerEvents(h, tenantId, 'meta')).slice(-1);
    expect(ev!.plugins).toEqual([expect.objectContaining({ plugin: 'decision-model', point: 'rerank', decision: 'applied', reason: 'ok', provider: 'openai_decisions', candidates: 10 })]);
    expect(ev!.plugins_ms).not.toBeNull();
    expect(JSON.stringify(ev)).not.toContain('férias');
    expect(JSON.stringify(ev)).not.toContain(CPF);
  });

  it('keeps the search result when the provider fails', async () => {
    fake.answer(new Error('provider down'));
    const c = await omni();
    expect(await search(c, 'saldo de horas extras do mês', 5)).toEqual(await baseline('saldo de horas extras do mês', 5));
    const [ev] = (await routerEvents(h, tenantId, 'meta')).slice(-1);
    expect(ev!.plugins![0]).toMatchObject({ point: 'rerank', decision: 'skipped', reason: 'error' });
  });

  it('only offers candidates the subject may call', async () => {
    await h.services.repos.policies.create(tenantId, { subjectType: 'role', subject: 'leitor', effect: 'allow', toolPattern: 'fin_*' });
    await h.services.registry.invalidate(tenantId);
    fake.answer({ tool: { type: 'choice', choice: 't2', probabilities: { t2: 0.9 }, confidence: 0.9 } });
    const c = await omni(await h.token({ tenant: 'acme', roles: ['leitor'], sub: 'leitor-router' }));
    const got = await search(c, 'pagamentos pendentes a fornecedores e colaboradores', 5);
    expect(got.every((n) => n.startsWith('fin_'))).toBe(true);
    const q = fake.requests[0]!.questions[0]!;
    const offered = q.type === 'choice' ? q.choices.filter((o) => o.value !== 'none').map((o) => optionTool(fake.requests[0]!, o.value)) : [];
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every((n) => n!.startsWith('fin_'))).toBe(true);
  });
});

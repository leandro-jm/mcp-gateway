import { SEARCH_EVAL } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallContext } from '../src/proxy/executor';
import { toRoutable } from '../src/router';
import { chooseTool, FakeDecisions } from './fake-decisions';
import { startHarness, type Harness } from './harness';
import { seedSyntheticTenant, setProvider, setRouter } from './router-helpers';

const CANDIDATES = 20;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/**
 * Offline evaluation of the rerank plumbing on the F7.1 set (200 tools). The oracle provider
 * always picks the expected tool when it is among the candidates, so its top-1 must equal the
 * search recall@candidates: the ceiling any real decision model can reach. Real providers are
 * measured with `scripts/router-eval.ts` (needs keys).
 */
describe('tool router evaluation on SEARCH_EVAL (F19.10)', () => {
  let h: Harness;
  let tenantId: string;
  const fake = new FakeDecisions();

  beforeAll(async () => {
    h = await startHarness({ env: { TOOL_ROUTER_ENABLED: 'true' }, decisions: fake.factory });
    tenantId = await seedSyntheticTenant(h, 'acme');
    await setProvider(h, tenantId);
    await setRouter(h, tenantId, { enabled: true, cacheTtlSeconds: 0, maxDecisionsPerMinute: 10_000, rerank: { candidates: CANDIDATES } });
  });
  afterAll(async () => h?.teardown());

  async function run(answer: (expected: string) => void) {
    const snapshot = await h.services.registry.get(tenantId);
    const ctx = { tenantId, snapshot, principal: { sub: 'eval', roles: ['agent'], groups: [], claims: {}, locale: 'en' } } as unknown as CallContext;
    let recall = 0;
    let ftsTop1 = 0;
    let top1 = 0;
    let top3 = 0;
    const unchanged: boolean[] = [];
    for (const { query, expected } of SEARCH_EVAL) {
      const pool = (await h.services.search.search(tenantId, query, snapshot.tools, CANDIDATES)).map((r) => r.tool);
      if (pool.some((t) => t.name === expected)) recall++;
      if (pool[0]?.name === expected) ftsTop1++;
      answer(expected);
      const r = await h.services.router!.rerank(ctx, query, pool.map(toRoutable), 3);
      if (r.names[0] === expected) top1++;
      if (r.names.includes(expected)) top3++;
      unchanged.push(JSON.stringify(r.names) === JSON.stringify(pool.slice(0, 3).map((t) => t.name)));
    }
    const n = SEARCH_EVAL.length;
    return { recall: recall / n, ftsTop1: ftsTop1 / n, top1: top1 / n, top3: top3 / n, unchanged };
  }

  it('an oracle decision model reaches the recall ceiling', async () => {
    const r = await run((expected) => fake.answer({ tool: chooseTool(expected) }));
    console.warn(`rerank eval (oracle): recall@${CANDIDATES}=${pct(r.recall)} FTS top-1=${pct(r.ftsTop1)} → top-1=${pct(r.top1)} top-3=${pct(r.top3)}`);
    expect(r.top1).toBe(r.recall);
    expect(r.top1).toBeGreaterThanOrEqual(0.95);
    expect(r.top1).toBeGreaterThanOrEqual(r.ftsTop1);
  });

  it('a failing provider leaves every search result unchanged', async () => {
    const r = await run(() => fake.answer(new Error('provider down')));
    expect(r.unchanged.every(Boolean)).toBe(true);
  });
});

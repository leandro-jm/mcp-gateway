import { hashingEmbedder, SEARCH_EVAL, syntheticTools } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, startInfra, type Harness, type Infra } from './harness';

async function seedSynthetic(h: Harness, slug: string): Promise<string> {
  const tenant = await h.services.repos.tenants.create({ slug, name: slug });
  for (const t of syntheticTools()) {
    await h.services.repos.tools.create(tenant.id, {
      kind: 'manual',
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
      tags: t.tags,
      state: 'enabled',
    });
  }
  return tenant.id;
}

describe('tool search (F7.1)', () => {
  let infra: Infra;
  let h: Harness;
  let hybrid: Harness;
  let tenantId: string;

  beforeAll(async () => {
    infra = await startInfra();
    h = await startHarness({ infra });
    hybrid = await startHarness({ infra, embeddings: hashingEmbedder() });
    tenantId = await seedSynthetic(h, 'acme');
  });
  afterAll(async () => {
    await h?.teardown();
    await hybrid?.teardown();
    await infra?.stop();
  });

  async function evaluate(harness: Harness) {
    const snap = await harness.services.registry.get(tenantId);
    expect(snap.tools).toHaveLength(200);
    const misses: string[] = [];
    for (const { query, expected } of SEARCH_EVAL) {
      const top = await harness.services.search.search(tenantId, query, snap.tools, 3);
      if (!top.some((r) => r.tool.name === expected)) misses.push(`${query} → expected ${expected}, got ${top.map((r) => r.tool.name).join(', ')}`);
    }
    return { rate: 1 - misses.length / SEARCH_EVAL.length, misses };
  }

  it('natural language queries bring the right tool in the top 3 in ≥ 90% of cases (FTS)', async () => {
    const { rate, misses } = await evaluate(h);
    console.warn(`top-3 FTS: ${(rate * 100).toFixed(1)}% (${SEARCH_EVAL.length} queries)\n${misses.join('\n')}`);
    expect(SEARCH_EVAL.length).toBeGreaterThanOrEqual(40);
    expect(rate).toBeGreaterThanOrEqual(0.9);
  });

  // The test embedder hashes words (no semantics): this validates the vector path and that
  // RRF fusion does not degrade the lexical ranking; the quality criterion is the FTS one.
  it('hybrid mode (FTS + embeddings, RRF) does not degrade quality', async () => {
    expect(await hybrid.services.search.refreshEmbeddings(tenantId)).toBe(200);
    expect(await hybrid.services.search.refreshEmbeddings(tenantId)).toBe(0); // nothing stale anymore
    const { rate, misses } = await evaluate(hybrid);
    console.warn(`top-3 hybrid: ${(rate * 100).toFixed(1)}%\n${misses.join('\n')}`);
    expect(rate).toBeGreaterThanOrEqual(0.85);
  });

  it('honors policy: returns only tools allowed to the subject', async () => {
    const snap = await h.services.registry.get(tenantId);
    const allowed = snap.tools.filter((t) => t.name.startsWith('fin_'));
    const res = await h.services.search.search(tenantId, 'quais funcionários estão ativos', allowed, 5);
    expect(res.every((r) => r.tool.name.startsWith('fin_'))).toBe(true);
    expect(await h.services.search.search(tenantId, 'colaboradores', [], 5)).toEqual([]);
  });

  it("the owner's override enters the index", async () => {
    const t = (await h.services.repos.tools.findByName(tenantId, 'ops_rondas_list'))!;
    await h.services.repos.tools.setOverrides(tenantId, t.id, { description: 'Lista patrulhas noturnas de segurança patrimonial' });
    const snap = await h.services.registry.get(tenantId);
    const [top] = await h.services.search.search(tenantId, 'patrulhas noturnas', snap.tools, 3);
    expect(top?.tool.id).toBe(t.id);
  });
});

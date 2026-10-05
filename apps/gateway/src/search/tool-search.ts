import { expandQuery, queryIntent, type QueryIntent } from '@mcp-gateway/core';
import type { ToolsRepo } from '@mcp-gateway/db';
import type { Logger } from '../logger';
import type { SnapshotTool } from '../registry/snapshot';
import type { EmbeddingProvider } from './embeddings';

export interface SearchResult {
  tool: SnapshotTool;
  score: number;
}

const RRF_K = 60;

/** Intent prior: breaks ties between operations on the same resource (read vs write, one vs many). */
function intentPrior(tool: SnapshotTool, intent: QueryIntent): number {
  if (intent === 'write') return tool.annotations.readOnlyHint ? 0 : 0.1;
  if (!tool.annotations.readOnlyHint) return 0;
  const verb = tool.baseName.split('_').at(-1);
  const one = verb === 'get' || Boolean((tool.inputSchema.required as string[] | undefined)?.includes('id'));
  return 0.15 + ((intent === 'read-one') === one ? 0.1 : 0);
}

/**
 * Tool search (F7.1): FTS (portuguese + simple, unaccented) with synonym expansion;
 * with an embeddings provider, fuses the lexical and vector rankings (Reciprocal Rank Fusion).
 * Only considers the tools passed in `allowed` (the ones the subject may call).
 */
export class ToolSearch {
  constructor(
    private readonly tools: ToolsRepo,
    private readonly logger: Logger,
    private readonly embeddings?: EmbeddingProvider,
  ) {}

  get hybrid(): boolean {
    return Boolean(this.embeddings);
  }

  async search(tenantId: string, query: string, allowed: SnapshotTool[], limit = 5): Promise<SearchResult[]> {
    if (!allowed.length || !query.trim()) return [];
    const byId = new Map(allowed.map((t) => [t.id, t]));
    const ids = [...byId.keys()];
    const depth = Math.max(limit * 4, 20);

    const expanded = expandQuery(query);
    const intent = queryIntent(expanded);
    const raw = await this.tools.search(tenantId, expanded, { ids, limit: depth });
    const lexical = raw
      .map((h) => ({ ...h, rank: h.rank * (1 + intentPrior(byId.get(h.id)!, intent)) }))
      .sort((a, b) => b.rank - a.rank);
    let vector: Array<{ id: string; rank: number }> = [];
    if (this.embeddings) {
      try {
        const [qv] = await this.embeddings.embed([query]);
        if (qv) vector = await this.tools.searchByVector(tenantId, qv, { ids, limit: depth });
      } catch (err) {
        this.logger.warn({ err: (err as Error).message }, 'vector search unavailable; using FTS only');
      }
    }

    const scores = new Map<string, number>();
    lexical.forEach((h, i) => scores.set(h.id, (scores.get(h.id) ?? 0) + 1 / (RRF_K + i + 1)));
    vector.forEach((h, i) => scores.set(h.id, (scores.get(h.id) ?? 0) + 1 / (RRF_K + i + 1)));
    return [...scores]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .flatMap(([id, score]) => {
        const tool = byId.get(id);
        return tool ? [{ tool, score: Number(score.toFixed(5)) }] : [];
      });
  }

  /** Recomputes embeddings of tools whose text changed (called by the indexer). */
  async refreshEmbeddings(tenantId: string, batch = 64): Promise<number> {
    if (!this.embeddings) return 0;
    let total = 0;
    for (;;) {
      const stale = await this.tools.staleEmbeddings(tenantId, batch);
      if (!stale.length) return total;
      const vectors = await this.embeddings.embed(stale.map((s) => s.searchText));
      for (let i = 0; i < stale.length; i++) await this.tools.setEmbedding(tenantId, stale[i]!.id, vectors[i]!, stale[i]!.hash);
      total += stale.length;
      if (stale.length < batch) return total;
    }
  }
}

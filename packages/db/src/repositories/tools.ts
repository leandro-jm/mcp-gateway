import { applyOverrides, buildSearchText, Conflict, NotFound, ValidationError, type ToolOverrides } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import { and, asc, count, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../client';
import { tools, toolVersions, type JsonObject, type OperationRef, type ToolAnnotations } from '../schema';
import { isUniqueViolation, pageLimit, pageOffset, type Page, type PageOpts } from './util';

export type Tool = typeof tools.$inferSelect;
export type ToolVersion = typeof toolVersions.$inferSelect;
export type ToolStateValue = Tool['state'];

export interface ToolFilter extends PageOpts {
  sourceId?: string;
  state?: ToolStateValue;
  ownerTeam?: string;
  kind?: Tool['kind'];
  /** Search by name (effective or generated) or description. */
  q?: string;
}

export interface ToolCreateInput {
  kind: Tool['kind'];
  sourceId?: string | null;
  compositeDefId?: string | null;
  operationKey?: string | null;
  name: string;
  title?: string | null;
  description?: string;
  operationRef?: OperationRef | null;
  inputSchema: JsonObject;
  outputSchema?: JsonObject | null;
  annotations?: ToolAnnotations;
  state?: ToolStateValue;
  specHash?: string | null;
  version?: number;
  ownerTeam?: string | null;
  tags?: string[];
}

export interface SearchHit {
  id: string;
  rank: number;
}

const searchTextOf = (t: Tool) => {
  const eff = applyOverrides(t);
  return buildSearchText({ ...eff, tags: t.tags, kind: t.kind, annotations: t.annotations });
};

/** Effective name (owner override or generated name). */
export const effectiveName = sql<string>`coalesce(${tools.overrides}->>'name', ${tools.name})`;

export class ToolsRepo {
  constructor(private readonly db: Db) {}

  /** Keeps `search_text` consistent with the effective name/description, parameters and tags. */
  private async refreshSearchText(db: Pick<Db, 'update'>, row: Tool): Promise<Tool> {
    const text = searchTextOf(row);
    if (text === row.searchText) return row;
    await db.update(tools).set({ searchText: text }).where(eq(tools.id, row.id));
    return { ...row, searchText: text };
  }

  async list(tenantId: string, f: ToolFilter = {}): Promise<Page<Tool>> {
    const conds: SQL[] = [eq(tools.tenantId, tenantId)];
    if (f.sourceId) conds.push(eq(tools.sourceId, f.sourceId));
    if (f.state) conds.push(eq(tools.state, f.state));
    if (f.ownerTeam) conds.push(eq(tools.ownerTeam, f.ownerTeam));
    if (f.kind) conds.push(eq(tools.kind, f.kind));
    if (f.q) {
      const like = `%${f.q.replace(/[%_]/g, '\\$&')}%`;
      conds.push(or(ilike(effectiveName, like), ilike(tools.name, like), ilike(tools.description, like))!);
    }
    const where = and(...conds);
    const items = await this.db
      .select()
      .from(tools)
      .where(where)
      .orderBy(asc(effectiveName))
      .limit(pageLimit(f))
      .offset(pageOffset(f));
    const [c] = await this.db.select({ n: count() }).from(tools).where(where);
    return { items, total: c?.n ?? 0 };
  }

  /** All the tenant's tools (no pagination), for the data plane snapshot. */
  async listAll(tenantId: string, states?: ToolStateValue[]): Promise<Tool[]> {
    const conds: SQL[] = [eq(tools.tenantId, tenantId)];
    if (states?.length) conds.push(sql`${tools.state} in ${states}`);
    return this.db.select().from(tools).where(and(...conds)).orderBy(asc(effectiveName));
  }

  async listBySource(tenantId: string, sourceId: string): Promise<Tool[]> {
    return this.db
      .select()
      .from(tools)
      .where(and(eq(tools.tenantId, tenantId), eq(tools.sourceId, sourceId)));
  }

  async get(tenantId: string, id: string): Promise<Tool> {
    const [row] = await this.db
      .select()
      .from(tools)
      .where(and(eq(tools.tenantId, tenantId), eq(tools.id, id)));
    if (!row) throw new NotFound('tool', id);
    return row;
  }

  async findByName(tenantId: string, name: string): Promise<Tool | undefined> {
    const [row] = await this.db
      .select()
      .from(tools)
      .where(and(eq(tools.tenantId, tenantId), eq(effectiveName, name)));
    return row;
  }

  async create(tenantId: string, input: ToolCreateInput): Promise<Tool> {
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(tools)
          .values({ ...input, tenantId })
          .returning();
        await tx.insert(toolVersions).values({
          toolId: row!.id,
          version: row!.version,
          specHash: row!.specHash,
          inputSchema: row!.inputSchema,
          outputSchema: row!.outputSchema,
        });
        return this.refreshSearchText(tx, row!);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new Conflict(msg('db.toolExists', { name: input.name }));
      throw err;
    }
  }

  /** Updates generated fields (used by the crawler) and records a new version when given. */
  async update(
    tenantId: string,
    id: string,
    patch: Partial<ToolCreateInput>,
    newVersion?: { diff: JsonObject },
  ): Promise<Tool> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(tools)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(tools.tenantId, tenantId), eq(tools.id, id)))
        .returning();
      if (!row) throw new NotFound('tool', id);
      if (newVersion) {
        await tx.insert(toolVersions).values({
          toolId: row.id,
          version: row.version,
          specHash: row.specHash,
          inputSchema: row.inputSchema,
          outputSchema: row.outputSchema,
          diff: newVersion.diff,
        });
      }
      return this.refreshSearchText(tx, row);
    });
  }

  async setOverrides(tenantId: string, id: string, overrides: ToolOverrides): Promise<Tool> {
    const clean = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined && v !== null));
    try {
      const [row] = await this.db
        .update(tools)
        .set({ overrides: clean, updatedAt: new Date() })
        .where(and(eq(tools.tenantId, tenantId), eq(tools.id, id)))
        .returning();
      if (!row) throw new NotFound('tool', id);
      return await this.refreshSearchText(this.db, row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new Conflict(msg('db.toolExists', { name: overrides.name ?? '' }));
      throw err;
    }
  }

  /** State change with an optimistic check of the previous state. */
  async setState(tenantId: string, id: string, from: ToolStateValue, to: ToolStateValue): Promise<Tool> {
    const [row] = await this.db
      .update(tools)
      .set({ state: to, updatedAt: new Date() })
      .where(and(eq(tools.tenantId, tenantId), eq(tools.id, id), eq(tools.state, from)))
      .returning();
    if (!row) throw new Conflict(msg('db.toolStateChanged'));
    return row;
  }

  /**
   * Text search with BM25-style scoring over Postgres FTS (Portuguese + simple, unaccented):
   * each query lexeme is weighted by its IDF among the candidates (`ids`, the tools the subject
   * may call) and by position (name/title = A, rest = B). Synonyms weigh less.
   */
  async search(
    tenantId: string,
    query: { terms: string[]; synonyms: string[] },
    opts: { ids: string[]; limit: number; synonymWeight?: number },
  ): Promise<SearchHit[]> {
    const clean = (xs: string[]) => xs.filter((t) => /^[a-z0-9]+$/.test(t)).join(' ');
    const orig = clean(query.terms);
    const syn = clean(query.synonyms);
    if ((!orig && !syn) || !opts.ids.length) return [];
    const sw = opts.synonymWeight ?? 0.6;
    const res = await this.db.execute<{ id: string; rank: number }>(sql`
      WITH terms AS (
        SELECT lexeme, max(weight) AS weight FROM (
          SELECT unnest(tsvector_to_array(to_tsvector('pt_unaccent', ${orig}))) AS lexeme, 1.0::float AS weight
          UNION ALL SELECT unnest(tsvector_to_array(to_tsvector('simple_unaccent', ${orig}))), 1.0::float
          UNION ALL SELECT unnest(tsvector_to_array(to_tsvector('pt_unaccent', ${syn}))), ${sw}::float
          UNION ALL SELECT unnest(tsvector_to_array(to_tsvector('simple_unaccent', ${syn}))), ${sw}::float
        ) x GROUP BY lexeme
      ),
      cand AS (
        SELECT id, name, search_tsv FROM tools
        WHERE tenant_id = ${tenantId} AND id = ANY(string_to_array(${opts.ids.join(',')}, ',')::uuid[])
      ),
      n AS (SELECT count(*)::float AS n FROM cand),
      stats AS (
        SELECT t.lexeme, t.weight, quote_literal(t.lexeme)::tsquery AS q, count(c.id)::float AS df
        FROM terms t LEFT JOIN cand c ON c.search_tsv @@ quote_literal(t.lexeme)::tsquery
        GROUP BY t.lexeme, t.weight
      )
      SELECT c.id, sum(s.weight * ln(1 + (n.n - s.df + 0.5) / (s.df + 0.5)) * ts_rank(c.search_tsv, s.q)) AS rank
      FROM cand c CROSS JOIN n JOIN stats s ON s.df > 0 AND c.search_tsv @@ s.q
      GROUP BY c.id, c.name
      ORDER BY rank DESC, c.name ASC
      LIMIT ${opts.limit}`);
    return res.rows.map((r) => ({ id: r.id, rank: Number(r.rank) }));
  }

  /** Vector search (pgvector), when embeddings exist. */
  async searchByVector(tenantId: string, embedding: number[], opts: { ids: string[]; limit: number }): Promise<SearchHit[]> {
    if (!opts.ids.length) return [];
    const vec = `[${embedding.join(',')}]`;
    const res = await this.db.execute<{ id: string; rank: number }>(sql`
      SELECT t.id, 1 - (t.embedding <=> ${vec}::vector) AS rank
      FROM tools t
      WHERE t.tenant_id = ${tenantId} AND t.id = ANY(string_to_array(${opts.ids.join(',')}, ',')::uuid[]) AND t.embedding IS NOT NULL
      ORDER BY t.embedding <=> ${vec}::vector
      LIMIT ${opts.limit}`);
    return res.rows.map((r) => ({ id: r.id, rank: Number(r.rank) }));
  }

  /** Tools whose text changed since the last embedding. */
  async staleEmbeddings(tenantId: string, limit = 100): Promise<Array<{ id: string; searchText: string; hash: string }>> {
    const res = await this.db.execute<{ id: string; search_text: string; hash: string }>(sql`
      SELECT id, search_text, md5(search_text) AS hash FROM tools
      WHERE tenant_id = ${tenantId} AND state <> 'removed'
        AND (embedding_hash IS NULL OR embedding_hash <> md5(search_text))
      LIMIT ${limit}`);
    return res.rows.map((r) => ({ id: r.id, searchText: r.search_text, hash: r.hash }));
  }

  async setEmbedding(tenantId: string, id: string, embedding: number[], hash: string): Promise<void> {
    const vec = `[${embedding.join(',')}]`;
    await this.db.execute(sql`
      UPDATE tools SET embedding = ${vec}::vector, embedding_hash = ${hash}
      WHERE tenant_id = ${tenantId} AND id = ${id}`);
  }

  async versions(tenantId: string, id: string): Promise<ToolVersion[]> {
    await this.get(tenantId, id);
    return this.db.select().from(toolVersions).where(eq(toolVersions.toolId, id)).orderBy(desc(toolVersions.version));
  }

  async version(tenantId: string, id: string, version: number): Promise<ToolVersion> {
    await this.get(tenantId, id);
    const [row] = await this.db
      .select()
      .from(toolVersions)
      .where(and(eq(toolVersions.toolId, id), eq(toolVersions.version, version)));
    if (!row) throw new ValidationError(msg('db.toolVersionNotFound', { version }));
    return row;
  }
}

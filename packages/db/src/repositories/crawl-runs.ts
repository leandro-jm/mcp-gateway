import { NotFound } from '@mcp-gateway/core';
import { translate, type ServerMessage } from '@mcp-gateway/i18n/server';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../client';
import { crawlRuns, type JsonObject } from '../schema';

export type CrawlRun = typeof crawlRuns.$inferSelect;

/** Max length of the persisted English error text. */
const MAX_ERROR_LENGTH = 2000;

export class CrawlRunsRepo {
  constructor(private readonly db: Db) {}

  async create(tenantId: string, sourceId: string, trigger: 'manual' | 'cron'): Promise<CrawlRun> {
    const [row] = await this.db.insert(crawlRuns).values({ tenantId, sourceId, trigger }).returning();
    return row!;
  }

  async get(tenantId: string, id: string): Promise<CrawlRun> {
    const [row] = await this.db
      .select()
      .from(crawlRuns)
      .where(and(eq(crawlRuns.tenantId, tenantId), eq(crawlRuns.id, id)));
    if (!row) throw new NotFound('crawlRun', id);
    return row;
  }

  async listBySource(tenantId: string, sourceId: string, limit = 20): Promise<CrawlRun[]> {
    return this.db
      .select()
      .from(crawlRuns)
      .where(and(eq(crawlRuns.tenantId, tenantId), eq(crawlRuns.sourceId, sourceId)))
      .orderBy(desc(crawlRuns.createdAt))
      .limit(limit);
  }

  async markRunning(tenantId: string, id: string): Promise<void> {
    await this.db
      .update(crawlRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(and(eq(crawlRuns.tenantId, tenantId), eq(crawlRuns.id, id)));
  }

  /**
   * Closes the run. A failure is stored as English text (`error`, for logs and as a fallback) plus
   * `error_key`/`error_params`, which the Admin API renders in the user's locale (ADR-012).
   */
  async finish(
    tenantId: string,
    id: string,
    result: { status: 'succeeded' | 'failed'; stats?: JsonObject; error?: ServerMessage },
  ): Promise<void> {
    const err = result.error;
    await this.db
      .update(crawlRuns)
      .set({
        status: result.status,
        stats: result.stats ?? {},
        error: err ? translate(err).slice(0, MAX_ERROR_LENGTH) : null,
        errorKey: err?.key ?? null,
        errorParams: err?.params ? (err.params as JsonObject) : null,
        finishedAt: new Date(),
      })
      .where(and(eq(crawlRuns.tenantId, tenantId), eq(crawlRuns.id, id)));
  }
}

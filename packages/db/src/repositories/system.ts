import { and, eq, lt, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { applyOverrides, buildSearchText } from '@mcp-gateway/core';
import { artifacts, piiTokens, tenants, tools, upstreamSources } from '../schema';

export interface SourceRef {
  tenantId: string;
  sourceId: string;
  crawlSchedule: string | null;
}

/**
 * System queries used by workers (crawler, scheduler) that operate across
 * all tenants. Never exposed by the Admin API. @cross-tenant
 */
export class SystemQueries {
  constructor(private readonly db: Db) {}

  /** Active sources of active tenants (optionally of a single tenant). */
  async activeSources(tenantId?: string): Promise<SourceRef[]> {
    const conds = [eq(upstreamSources.status, 'active'), eq(tenants.status, 'active')];
    if (tenantId) conds.push(eq(upstreamSources.tenantId, tenantId));
    return this.db
      .select({
        tenantId: upstreamSources.tenantId,
        sourceId: upstreamSources.id,
        crawlSchedule: upstreamSources.crawlSchedule,
      })
      .from(upstreamSources)
      .innerJoin(tenants, eq(tenants.id, upstreamSources.tenantId))
      .where(and(...conds));
  }

  async scheduledSources(): Promise<SourceRef[]> {
    return (await this.activeSources()).filter((s) => s.crawlSchedule);
  }

  /** Expired artifacts (of any tenant), for the periodic cleanup. */
  async expiredArtifacts(limit = 500, now = new Date()): Promise<Array<{ id: string; tenantId: string; objectKey: string }>> {
    return this.db
      .select({ id: artifacts.id, tenantId: artifacts.tenantId, objectKey: artifacts.objectKey })
      .from(artifacts)
      .where(lt(artifacts.expiresAt, now))
      .limit(limit);
  }

  async deleteArtifactRows(ids: string[]): Promise<void> {
    for (const id of ids) await this.db.delete(artifacts).where(eq(artifacts.id, id));
  }

  /** Deletes expired PII tokens of every tenant. */
  async deleteExpiredPiiTokens(now = new Date()): Promise<number> {
    const rows = await this.db.delete(piiTokens).where(lt(piiTokens.expiresAt, now)).returning({ token: piiTokens.token });
    return rows.length;
  }

  /** Ensures monthly audit partitions from the current month up to `monthsAhead` months ahead. */
  async ensureAuditPartitions(monthsAhead = 2): Promise<string[]> {
    const created: string[] = [];
    for (let i = 0; i <= monthsAhead; i++) {
      const res = await this.db.execute<{ part: string }>(
        sql`SELECT audit_ensure_partition((date_trunc('month', now()) + make_interval(months => ${i}))::date) AS part`,
      );
      created.push(res.rows[0]!.part);
    }
    return created;
  }

  /** Drops audit partitions older than the retention (in months). */
  async dropAuditPartitionsOlderThan(retentionMonths: number, now = new Date()): Promise<string[]> {
    return this.dropMonthlyPartitions('audit_events', retentionMonths, now);
  }

  /** Ensures monthly LGPD subject index partitions (F15.11). */
  async ensureSubjectRefPartitions(monthsAhead = 2): Promise<string[]> {
    const created: string[] = [];
    for (let i = 0; i <= monthsAhead; i++) {
      const res = await this.db.execute<{ part: string }>(
        sql`SELECT call_subject_refs_ensure_partition((date_trunc('month', now()) + make_interval(months => ${i}))::date) AS part`,
      );
      created.push(res.rows[0]!.part);
    }
    return created;
  }

  /** Drops subject index partitions older than the retention (in months). */
  async dropSubjectRefPartitionsOlderThan(retentionMonths: number, now = new Date()): Promise<string[]> {
    return this.dropMonthlyPartitions('call_subject_refs', retentionMonths, now);
  }

  /** Drops `<parent>_yYYYYmMM` partitions that start before the retention cutoff. */
  private async dropMonthlyPartitions(parent: string, retentionMonths: number, now: Date): Promise<string[]> {
    const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - retentionMonths, 1));
    const dropped: string[] = [];
    const re = new RegExp(`^${parent}_y(\\d{4})m(\\d{2})$`);
    for (const name of await this.partitionsOf(parent)) {
      const m = re.exec(name);
      if (!m) continue;
      const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
      if (start < cutoff) {
        await this.db.execute(sql.raw(`DROP TABLE IF EXISTS "${name}"`));
        dropped.push(name);
      }
    }
    return dropped;
  }

  /** Names of the partitions of a partitioned table. */
  private async partitionsOf(parent: string): Promise<string[]> {
    const res = await this.db.execute<{ name: string }>(sql`
      SELECT c.relname AS name FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = ${parent}`);
    return res.rows.map((r) => r.name);
  }

  /** Ensures daily `call_events` partitions from today up to `daysAhead` days ahead (F15.5). */
  async ensureCallEventPartitions(daysAhead = 3): Promise<string[]> {
    const created: string[] = [];
    for (let i = 0; i <= daysAhead; i++) {
      const res = await this.db.execute<{ part: string }>(
        sql`SELECT call_events_ensure_partition((now() + make_interval(days => ${i}))::date) AS part`,
      );
      created.push(res.rows[0]!.part);
    }
    return created;
  }

  /** Drops daily `call_events` partitions older than the retention (in days). */
  async dropCallEventPartitionsOlderThan(retentionDays: number, now = new Date()): Promise<string[]> {
    const cutoff = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - retentionDays);
    const dropped: string[] = [];
    for (const name of await this.partitionsOf('call_events')) {
      const m = /^call_events_p(\d{4})(\d{2})(\d{2})$/.exec(name);
      if (!m) continue;
      if (Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) < cutoff) {
        await this.db.execute(sql.raw(`DROP TABLE IF EXISTS "${name}"`));
        dropped.push(name);
      }
    }
    return dropped;
  }

  /** Fills `search_text` of old tools (prior to F7.1). */
  async backfillSearchText(limit = 1000): Promise<number> {
    const rows = await this.db.select().from(tools).where(eq(tools.searchText, '')).limit(limit);
    for (const t of rows) {
      const eff = applyOverrides(t);
      await this.db.update(tools).set({ searchText: buildSearchText({ ...eff, tags: t.tags, kind: t.kind, annotations: t.annotations }) }).where(eq(tools.id, t.id));
    }
    return rows.length;
  }

  async tenantIds(): Promise<string[]> {
    return (await this.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'))).map((r) => r.id);
  }
}


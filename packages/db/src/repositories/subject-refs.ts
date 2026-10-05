import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { callSubjectRefs } from '../schema';
import { TRUNCATED_DETECTOR } from './call-events';

export type SubjectRefRow = Omit<typeof callSubjectRefs.$inferSelect, 'fp'>;

const columns = {
  ts: callSubjectRefs.ts,
  tenantId: callSubjectRefs.tenantId,
  callId: callSubjectRefs.callId,
  detector: callSubjectRefs.detector,
  direction: callSubjectRefs.direction,
  subject: callSubjectRefs.subject,
  clientId: callSubjectRefs.clientId,
  agentName: callSubjectRefs.agentName,
  toolName: callSubjectRefs.toolName,
  decision: callSubjectRefs.decision,
};

/** LGPD subject index reads (ADR-017): by fingerprint only, never by value. */
export class SubjectRefsRepo {
  constructor(private readonly db: Db) {}

  /** Calls in which the fingerprinted identifier was seen, newest first. */
  async lookup(tenantId: string, fp: Buffer, from: Date, to: Date, limit = 1000): Promise<SubjectRefRow[]> {
    return this.db
      .select(columns)
      .from(callSubjectRefs)
      .where(and(eq(callSubjectRefs.tenantId, tenantId), eq(callSubjectRefs.fp, fp), gte(callSubjectRefs.ts, from), lt(callSubjectRefs.ts, to)))
      .orderBy(desc(callSubjectRefs.ts))
      .limit(limit);
  }

  /** Calls with more subjects than the per-call cap: they may contain the subject. */
  async truncatedCalls(tenantId: string, from: Date, to: Date, limit = 200): Promise<SubjectRefRow[]> {
    return this.db
      .select(columns)
      .from(callSubjectRefs)
      .where(and(eq(callSubjectRefs.tenantId, tenantId), eq(callSubjectRefs.detector, TRUNCATED_DETECTOR), gte(callSubjectRefs.ts, from), lt(callSubjectRefs.ts, to)))
      .orderBy(desc(callSubjectRefs.ts))
      .limit(limit);
  }

  async count(tenantId: string): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(callSubjectRefs).where(eq(callSubjectRefs.tenantId, tenantId));
    return row?.n ?? 0;
  }
}

import type { Finding, SequenceSupport, TrajectoryEvent, Transition } from '@mcp-gateway/call-analytics';
import { and, desc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../client';
import { agentFindings, callEvents, callOutcomes, compositeSuggestions, toolTransitionsDaily } from '../schema';

export type AgentFinding = typeof agentFindings.$inferSelect;
export type CompositeSuggestion = typeof compositeSuggestions.$inferSelect;
export type CallOutcome = typeof callOutcomes.$inferSelect;
export type CallOutcomeInput = Omit<typeof callOutcomes.$inferInsert, 'id' | 'tenantId'>;

/** Agent analytics storage (F15.21/F15.22): findings, co-usage, composite suggestions, outcomes. */
export class AgentAnalyticsRepo {
  constructor(private readonly db: Db) {}

  /** Tool and meta events of a period, oldest first (input of sessionization). */
  async trajectoryEvents(tenantId: string, from: Date, to: Date, limit = 100_000): Promise<TrajectoryEvent[]> {
    const rows = await this.db
      .select({
        ts: callEvents.ts,
        callId: callEvents.callId,
        sessionKey: callEvents.sessionKey,
        subject: callEvents.subject,
        agentName: callEvents.agentName,
        kind: callEvents.kind,
        toolName: callEvents.toolName,
        decision: callEvents.decision,
        errorCode: callEvents.errorCode,
        errorStage: callEvents.errorStage,
        argsHash: callEvents.argsHash,
        meta: callEvents.meta,
      })
      .from(callEvents)
      .where(and(eq(callEvents.tenantId, tenantId), gte(callEvents.ts, from), lt(callEvents.ts, to), inArray(callEvents.kind, ['tool', 'meta'])))
      .orderBy(callEvents.ts)
      .limit(limit);
    return rows.filter((r) => r.sessionKey).map((r) => ({ ...r, sessionKey: r.sessionKey!, meta: r.meta as TrajectoryEvent['meta'] }));
  }

  async upsertFindings(tenantId: string, findings: Finding[]): Promise<number> {
    if (!findings.length) return 0;
    const rows = await this.db
      .insert(agentFindings)
      .values(
        findings.map((f) => ({
          tenantId,
          type: f.type,
          sessionId: f.sessionId,
          sessionKey: f.sessionKey,
          subject: f.subject,
          agentName: f.agentName,
          tool: f.tool,
          related: f.related ?? [],
          count: f.count,
          detail: f.detail ?? null,
          firstCallId: f.firstCallId,
          lastCallId: f.lastCallId,
          at: f.at,
        })),
      )
      .onConflictDoUpdate({
        target: [agentFindings.tenantId, agentFindings.type, agentFindings.firstCallId, agentFindings.tool],
        set: { count: sql`excluded.count`, lastCallId: sql`excluded.last_call_id`, at: sql`excluded.at` },
      })
      .returning({ id: agentFindings.id });
    return rows.length;
  }

  async findings(tenantId: string, f: { from?: Date; type?: string; sessionKey?: string; limit?: number } = {}): Promise<AgentFinding[]> {
    const conds: SQL[] = [eq(agentFindings.tenantId, tenantId)];
    if (f.from) conds.push(gte(agentFindings.at, f.from));
    if (f.type) conds.push(eq(agentFindings.type, f.type));
    if (f.sessionKey) conds.push(eq(agentFindings.sessionKey, f.sessionKey));
    return this.db.select().from(agentFindings).where(and(...conds)).orderBy(desc(agentFindings.at)).limit(Math.min(f.limit ?? 200, 1000));
  }

  /** Replaces the co-usage counts of the given days. */
  async replaceTransitions(tenantId: string, days: Map<string, Transition[]>): Promise<void> {
    for (const [day, list] of days) {
      await this.db.delete(toolTransitionsDaily).where(and(eq(toolTransitionsDaily.tenantId, tenantId), eq(toolTransitionsDaily.day, day)));
      if (list.length) await this.db.insert(toolTransitionsDaily).values(list.map((t) => ({ tenantId, day, fromTool: t.from, toTool: t.to, count: t.count })));
    }
  }

  async coUsage(tenantId: string, from: string, to: string, limit = 100): Promise<Transition[]> {
    const rows = await this.db
      .select({ from: toolTransitionsDaily.fromTool, to: toolTransitionsDaily.toTool, count: sql<number>`sum(${toolTransitionsDaily.count})::int` })
      .from(toolTransitionsDaily)
      .where(and(eq(toolTransitionsDaily.tenantId, tenantId), gte(toolTransitionsDaily.day, from), sql`${toolTransitionsDaily.day} <= ${to}`))
      .groupBy(toolTransitionsDaily.fromTool, toolTransitionsDaily.toTool)
      .orderBy(desc(sql`sum(${toolTransitionsDaily.count})`))
      .limit(limit);
    return rows;
  }

  /** New sequences become open suggestions; open ones get fresh numbers; dismissed or accepted ones are left alone. */
  async upsertSuggestions(tenantId: string, seqs: SequenceSupport[], now = new Date()): Promise<void> {
    if (!seqs.length) return;
    await this.db
      .insert(compositeSuggestions)
      .values(seqs.map((s) => ({ tenantId, sequenceHash: s.hash, sequence: s.sequence, sessions: s.sessions, subjects: s.subjects, share: s.share, firstSeen: now, lastSeen: now })))
      .onConflictDoUpdate({
        target: [compositeSuggestions.tenantId, compositeSuggestions.sequenceHash],
        set: { sessions: sql`excluded.sessions`, subjects: sql`excluded.subjects`, share: sql`excluded.share`, lastSeen: sql`excluded.last_seen` },
        setWhere: sql`${compositeSuggestions.status} = 'open'`,
      });
  }

  async suggestions(tenantId: string, status?: CompositeSuggestion['status']): Promise<CompositeSuggestion[]> {
    const conds: SQL[] = [eq(compositeSuggestions.tenantId, tenantId)];
    if (status) conds.push(eq(compositeSuggestions.status, status));
    return this.db.select().from(compositeSuggestions).where(and(...conds)).orderBy(desc(compositeSuggestions.sessions), desc(compositeSuggestions.lastSeen)).limit(200);
  }

  async suggestion(tenantId: string, id: string): Promise<CompositeSuggestion | undefined> {
    const [row] = await this.db.select().from(compositeSuggestions).where(and(eq(compositeSuggestions.tenantId, tenantId), eq(compositeSuggestions.id, id)));
    return row;
  }

  async setSuggestionStatus(tenantId: string, id: string, status: CompositeSuggestion['status'], compositeId?: string): Promise<CompositeSuggestion | undefined> {
    const [row] = await this.db
      .update(compositeSuggestions)
      .set({ status, ...(compositeId ? { compositeId } : {}) })
      .where(and(eq(compositeSuggestions.tenantId, tenantId), eq(compositeSuggestions.id, id)))
      .returning();
    return row;
  }

  async insertOutcome(tenantId: string, input: CallOutcomeInput): Promise<CallOutcome> {
    const [row] = await this.db.insert(callOutcomes).values({ ...input, tenantId }).returning();
    return row!;
  }

  /** Last outcome of a session (calls after it belong to the next task). */
  async lastOutcome(tenantId: string, sessionKey: string): Promise<CallOutcome | undefined> {
    const [row] = await this.db
      .select()
      .from(callOutcomes)
      .where(and(eq(callOutcomes.tenantId, tenantId), eq(callOutcomes.sessionKey, sessionKey)))
      .orderBy(desc(callOutcomes.ts))
      .limit(1);
    return row;
  }

  async outcomes(tenantId: string, from: Date, to: Date, limit = 5000): Promise<CallOutcome[]> {
    return this.db
      .select()
      .from(callOutcomes)
      .where(and(eq(callOutcomes.tenantId, tenantId), gte(callOutcomes.ts, from), lt(callOutcomes.ts, to)))
      .orderBy(desc(callOutcomes.ts))
      .limit(limit);
  }

  /** Calls of the tenant by id (validates call ids sent by clients). */
  async callsByIds(tenantId: string, ids: string[], from: Date): Promise<Array<{ callId: string; subject: string; toolName: string; virtualServerId: string | null }>> {
    if (!ids.length) return [];
    return this.db
      .select({ callId: callEvents.callId, subject: callEvents.subject, toolName: callEvents.toolName, virtualServerId: callEvents.virtualServerId })
      .from(callEvents)
      .where(and(eq(callEvents.tenantId, tenantId), inArray(callEvents.callId, ids), gte(callEvents.ts, from)));
  }

  /** Tool calls of a session since a point in time (implicit outcome linking). */
  async sessionCalls(tenantId: string, sessionKey: string, since: Date, limit = 50): Promise<Array<{ callId: string; toolName: string; virtualServerId: string | null }>> {
    return this.db
      .select({ callId: callEvents.callId, toolName: callEvents.toolName, virtualServerId: callEvents.virtualServerId })
      .from(callEvents)
      .where(and(eq(callEvents.tenantId, tenantId), eq(callEvents.sessionKey, sessionKey), eq(callEvents.kind, 'tool'), gte(callEvents.ts, since)))
      .orderBy(desc(callEvents.ts))
      .limit(limit);
  }

  /** Sessions of a period (by session key), newest activity first. */
  async sessions(tenantId: string, from: Date, to: Date, f: { agent?: string; subject?: string; limit?: number } = {}): Promise<SessionSummary[]> {
    const conds: SQL[] = [
      eq(callEvents.tenantId, tenantId),
      gte(callEvents.ts, from),
      lt(callEvents.ts, to),
      sql`${callEvents.sessionKey} IS NOT NULL`,
      inArray(callEvents.kind, ['tool', 'meta']),
    ];
    if (f.agent) conds.push(eq(callEvents.agentName, f.agent));
    if (f.subject) conds.push(eq(callEvents.subject, f.subject));
    const rows = await this.db
      .select({
        sessionKey: sql<string>`${callEvents.sessionKey}`,
        subject: sql<string>`min(${callEvents.subject})`,
        agentName: sql<string | null>`max(${callEvents.agentName})`,
        endpoint: sql<string>`min(${callEvents.endpoint})`,
        start: sql<Date>`min(${callEvents.ts})`,
        end: sql<Date>`max(${callEvents.ts})`,
        calls: sql<number>`count(*) FILTER (WHERE ${callEvents.kind} = 'tool')::int`,
        errors: sql<number>`count(*) FILTER (WHERE ${callEvents.kind} = 'tool' AND ${callEvents.decision} <> 'allow')::int`,
        tools: sql<number>`count(DISTINCT ${callEvents.toolName}) FILTER (WHERE ${callEvents.kind} = 'tool')::int`,
      })
      .from(callEvents)
      .where(and(...conds))
      .groupBy(callEvents.sessionKey)
      .orderBy(desc(sql`max(${callEvents.ts})`))
      .limit(Math.min(f.limit ?? 100, 500));
    return rows.map((r) => ({ ...r, start: new Date(r.start), end: new Date(r.end) }));
  }
}

export interface SessionSummary {
  sessionKey: string;
  subject: string;
  agentName: string | null;
  endpoint: string;
  start: Date;
  end: Date;
  calls: number;
  errors: number;
  tools: number;
}

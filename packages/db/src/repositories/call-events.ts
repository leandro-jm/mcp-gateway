import { uuidv7Time, type CallEvent } from '@mcp-gateway/call-analytics';
import { and, asc, desc, eq, getTableColumns, gte, inArray, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../client';
import { callEvents, callSubjectRefs, type JsonObject } from '../schema';

export type CallEventRow = typeof callEvents.$inferSelect;
export type CallEventInsert = typeof callEvents.$inferInsert;

const ms = (v: number | undefined): number | null => (v === undefined ? null : Math.round(v));

/** Maps the wide event to its row (columns for everything filtered or summed, jsonb for the rest). */
export function toCallEventRow(ev: CallEvent): CallEventInsert {
  const st = ev.stages ?? {};
  return {
    ts: ev.ts,
    callId: ev.callId,
    parentCallId: ev.parentCallId ?? null,
    tenantId: ev.tenantId,
    kind: ev.kind,
    endpoint: ev.endpoint,
    subject: ev.subject,
    clientId: ev.clientId ?? null,
    agentName: ev.agentName ?? null,
    agentVersion: ev.agentVersion ?? null,
    sessionKey: ev.sessionKey ?? null,
    sessionSource: ev.sessionSource ?? null,
    virtualServerId: ev.virtualServerId ?? null,
    requestId: ev.requestId ?? null,
    jsonrpcId: ev.jsonrpcId ?? null,
    protocolVersion: ev.protocolVersion ?? null,
    traceId: ev.traceId ?? null,
    spanId: ev.spanId ?? null,
    inboundParentSpanId: ev.inboundParentSpanId ?? null,
    toolId: ev.toolId ?? null,
    toolName: ev.toolName,
    toolVersion: ev.toolVersion ?? null,
    toolKind: ev.toolKind ?? null,
    sourceId: ev.sourceId ?? null,
    viaOmni: ev.viaOmni ?? false,
    decision: ev.decision,
    errorCode: ev.errorCode ?? null,
    errorStage: ev.errorStage ?? null,
    errorKey: ev.errorKey ?? null,
    upstreamStatus: ev.upstreamStatus ?? null,
    attempts: ev.attempts ?? null,
    policyRuleId: ev.policyRuleId ?? null,
    policyReason: ev.policyReason ?? null,
    policyVersion: ev.policyVersion ?? null,
    policyTrace: ev.policyTrace ?? null,
    redactionsCount: ev.redactionsCount ?? 0,
    redactionsByDetector: ev.redactionsByDetector ?? null,
    detokenizedCount: ev.detokenizedCount ?? 0,
    requestBytes: ev.requestBytes ?? null,
    upstreamBytes: ev.upstreamBytes ?? null,
    bytesBeforeProjection: ev.bytesBeforeProjection ?? null,
    bytesAfterProjection: ev.bytesAfterProjection ?? null,
    responseBytes: ev.responseBytes ?? null,
    projection: (ev.projection as JsonObject | null | undefined) ?? null,
    artifactId: ev.artifactId ?? null,
    artifactBytes: ev.artifactBytes ?? null,
    subjectRefsCount: ev.subjectRefsCount ?? 0,
    subjectRefsTruncated: ev.subjectRefsTruncated ?? false,
    meta: (ev.meta as JsonObject | null | undefined) ?? null,
    argsHash: ev.argsHash ?? null,
    latencyMs: Math.max(0, Math.round(ev.latencyMs)),
    authzMs: ms(st.authz),
    validationMs: ms(st.validation),
    piiMs: ms(st.pii),
    upstreamMs: ms(st.upstream),
    projectionMs: ms(st.projection),
    artifactMs: ms(st.artifact),
    pluginsMs: ms(st.plugins),
    defTokens: ev.defTokens ?? null,
    responseTokens: ev.responseTokens ?? null,
    rawTokens: ev.rawTokens ?? null,
    tokensSavedProjection: ev.tokensSavedProjection ?? 0,
    tokensSavedArtifact: ev.tokensSavedArtifact ?? 0,
    catalogTokens: ev.catalogTokens ?? null,
    plugins: ev.plugins ?? null,
    gate: (ev.gate as JsonObject | null | undefined) ?? null,
    taint: (ev.taint as JsonObject | null | undefined) ?? null,
    pinnedVersion: ev.pinnedVersion ?? null,
  };
}

/** Column names of a table, minus generated ones, in a stable order. */
function columnsOf(table: typeof callEvents | typeof callSubjectRefs, skip: string[] = []): Array<[string, string]> {
  return Object.entries(getTableColumns(table))
    .filter(([prop]) => !skip.includes(prop))
    .map(([prop, col]) => [prop, col.name]);
}

const EVENT_COLUMNS = columnsOf(callEvents, ['overheadMs']);
const REF_COLUMNS = columnsOf(callSubjectRefs);

/** Rows as one JSON document keyed by column name (bytea as hex input). */
function asJson(rows: Array<Record<string, unknown>>, columns: Array<[string, string]>): string {
  return JSON.stringify(
    rows.map((r) => {
      const o: Record<string, unknown> = {};
      for (const [prop, name] of columns) {
        const v = r[prop];
        o[name] = Buffer.isBuffer(v) ? `\\x${v.toString('hex')}` : (v ?? null);
      }
      return o;
    }),
  );
}

/**
 * One parameter per batch (`json_populate_recordset`): building a statement with tens of
 * thousands of bound values would block the event loop on every flush.
 */
function insertJson(table: string, columns: Array<[string, string]>, json: string, onConflict = ''): SQL {
  const cols = columns.map(([, name]) => `"${name}"`).join(', ');
  return sql`${sql.raw(`INSERT INTO ${table} (${cols}) SELECT ${cols} FROM json_populate_recordset(null::${table}, `)}${json}${sql.raw(`::json) ${onConflict}`)}`;
}

export interface SubjectRefInput {
  detector: string;
  fp: Buffer;
  direction: 'request' | 'response';
}

/** Marker row of a call whose subjects went past the per-call cap. */
export const TRUNCATED_DETECTOR = '*';

/**
 * Batched writer used by the analytics sink: events of every tenant in one insert.
 * Write-only, never exposed by the Admin API. @cross-tenant
 */
export class CallEventWriter {
  constructor(private readonly db: Db) {}

  async insertBatch(events: CallEvent[]): Promise<number> {
    return this.insertBatchWithRefs(events.map((event) => ({ event })));
  }

  /** Events and their LGPD subject refs (ADR-017) in one transaction. */
  async insertBatchWithRefs(items: Array<{ event: CallEvent; refs?: SubjectRefInput[] }>): Promise<number> {
    if (!items.length) return 0;
    const refRows = items.flatMap(({ event: ev, refs = [] }) => {
      const base = {
        ts: ev.ts,
        tenantId: ev.tenantId,
        callId: ev.callId,
        subject: ev.subject,
        clientId: ev.clientId ?? null,
        agentName: ev.agentName ?? null,
        toolName: ev.toolName,
        decision: ev.decision,
      };
      const rows: Array<Record<string, unknown>> = refs.map((r) => ({ ...base, detector: r.detector, fp: r.fp, direction: r.direction }));
      if (ev.subjectRefsTruncated) rows.push({ ...base, detector: TRUNCATED_DETECTOR, fp: Buffer.alloc(0), direction: 'response' });
      return rows;
    });
    const events = insertJson('call_events', EVENT_COLUMNS, asJson(items.map((i) => toCallEventRow(i.event) as Record<string, unknown>), EVENT_COLUMNS), 'ON CONFLICT DO NOTHING');
    if (!refRows.length) {
      await this.db.execute(events);
      return items.length;
    }
    await this.db.transaction(async (tx) => {
      await tx.execute(events);
      await tx.execute(insertJson('call_subject_refs', REF_COLUMNS, asJson(refRows, REF_COLUMNS)));
    });
    return items.length;
  }
}

export interface CallEventFilter {
  from?: Date;
  to?: Date;
  kind?: string;
  toolName?: string;
  decision?: string;
  errorCode?: string;
  clientId?: string;
  agentName?: string;
  sessionKey?: string;
  traceId?: string;
  /** Restricts to these tools (tool owners). */
  toolNames?: string[];
  /** Keyset pagination: rows strictly older than this `(ts, callId)`. */
  before?: { ts: Date; callId: string };
  limit?: number;
}

/** Window around the time embedded in a UUIDv7: lets Postgres prune partitions. */
const ID_WINDOW_MS = 60_000;

export class CallEventsRepo {
  constructor(private readonly db: Db) {}

  private idConds(tenantId: string, callId: string): SQL[] {
    const conds: SQL[] = [eq(callEvents.tenantId, tenantId), eq(callEvents.callId, callId)];
    const t = uuidv7Time(callId);
    if (t) conds.push(gte(callEvents.ts, new Date(t.getTime() - ID_WINDOW_MS)), lte(callEvents.ts, new Date(t.getTime() + ID_WINDOW_MS)));
    return conds;
  }

  async get(tenantId: string, callId: string): Promise<CallEventRow | undefined> {
    const [row] = await this.db.select().from(callEvents).where(and(...this.idConds(tenantId, callId))).limit(1);
    return row;
  }

  /** Composite steps of a call, in execution order. */
  async children(tenantId: string, callId: string): Promise<CallEventRow[]> {
    const conds: SQL[] = [eq(callEvents.tenantId, tenantId), eq(callEvents.parentCallId, callId)];
    const t = uuidv7Time(callId);
    if (t) conds.push(gte(callEvents.ts, new Date(t.getTime() - ID_WINDOW_MS)));
    return this.db.select().from(callEvents).where(and(...conds)).orderBy(asc(callEvents.ts)).limit(1000);
  }

  async list(tenantId: string, f: CallEventFilter = {}): Promise<CallEventRow[]> {
    const conds: SQL[] = [eq(callEvents.tenantId, tenantId)];
    if (f.from) conds.push(gte(callEvents.ts, f.from));
    if (f.to) conds.push(lt(callEvents.ts, f.to));
    if (f.kind) conds.push(eq(callEvents.kind, f.kind));
    if (f.toolName) conds.push(eq(callEvents.toolName, f.toolName));
    if (f.decision) conds.push(eq(callEvents.decision, f.decision));
    if (f.errorCode) conds.push(eq(callEvents.errorCode, f.errorCode));
    if (f.clientId) conds.push(eq(callEvents.clientId, f.clientId));
    if (f.agentName) conds.push(eq(callEvents.agentName, f.agentName));
    if (f.sessionKey) conds.push(eq(callEvents.sessionKey, f.sessionKey));
    if (f.traceId) conds.push(eq(callEvents.traceId, f.traceId));
    if (f.toolNames) conds.push(f.toolNames.length ? inArray(callEvents.toolName, f.toolNames) : sql`false`);
    if (f.before) {
      conds.push(or(lt(callEvents.ts, f.before.ts), and(eq(callEvents.ts, f.before.ts), lt(callEvents.callId, f.before.callId)))!);
    }
    return this.db
      .select()
      .from(callEvents)
      .where(and(...conds))
      .orderBy(desc(callEvents.ts), desc(callEvents.callId))
      .limit(Math.min(Math.max(f.limit ?? 50, 1), 500));
  }

  /** Every event of a session in a time range, oldest first (trajectories). */
  async bySession(tenantId: string, sessionKey: string, from: Date, to: Date, limit = 2000): Promise<CallEventRow[]> {
    return this.db
      .select()
      .from(callEvents)
      .where(and(eq(callEvents.tenantId, tenantId), eq(callEvents.sessionKey, sessionKey), gte(callEvents.ts, from), lt(callEvents.ts, to)))
      .orderBy(asc(callEvents.ts))
      .limit(limit);
  }

  async count(tenantId: string, from: Date, to: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(callEvents)
      .where(and(eq(callEvents.tenantId, tenantId), gte(callEvents.ts, from), lt(callEvents.ts, to)));
    return row?.n ?? 0;
  }
}

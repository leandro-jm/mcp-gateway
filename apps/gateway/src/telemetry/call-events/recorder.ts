import {
  estimateTokens,
  tokensSaved,
  uuidv7,
  type CallEvent,
  type CallEventKind,
  type ErrorStage,
  type EventToolKind,
  type EventMeta,
  type Stage,
} from '@mcp-gateway/call-analytics';
import { Forbidden, isGatewayError, RateLimited, ToolDisabled, ToolNotFound, UpstreamError, ValidationError } from '@mcp-gateway/core';
import type { Decision } from '@mcp-gateway/policy';
import type { CallContext } from '../../proxy/executor';
import { CircuitOpen } from '../../proxy/guards';
import { errorPayload, type ToolResult } from '../../proxy/result';
import { NetworkError, ResponseTooLarge, UpstreamTimeout } from '../../proxy/rest-adapter';
import type { SnapshotTool } from '../../registry/snapshot';
import type { SubjectRef } from './sink';

export interface ClassifiedError {
  code: string;
  stage: ErrorStage;
  key?: string;
}

const STAGE_TO_ERROR: Partial<Record<Stage, ErrorStage>> = {
  authz: 'authz',
  validation: 'validation',
  pii: 'redaction',
  upstream: 'upstream',
  projection: 'projection',
  artifact: 'artifact',
};

/** Error code, pipeline stage and message key (never params, which may carry values). */
export function classifyError(err: unknown, currentStage?: Stage): ClassifiedError {
  if (!isGatewayError(err)) return { code: 'INTERNAL_ERROR', stage: (currentStage && STAGE_TO_ERROR[currentStage]) ?? 'internal' };
  const key = err.msg.key;
  if (err instanceof Forbidden) return { code: err.code, stage: 'authz', key };
  if (err instanceof ValidationError) return { code: err.code, stage: 'validation', key };
  if (err instanceof RateLimited) return { code: err.code, stage: 'rate_limit', key };
  if (err instanceof ToolNotFound || err instanceof ToolDisabled) return { code: err.code, stage: 'protocol', key };
  if (err instanceof CircuitOpen) return { code: 'CIRCUIT_OPEN', stage: 'circuit', key };
  if (err instanceof UpstreamTimeout) return { code: 'UPSTREAM_TIMEOUT', stage: 'upstream', key };
  if (err instanceof ResponseTooLarge) return { code: 'RESPONSE_TOO_LARGE', stage: 'upstream', key };
  if (err instanceof NetworkError) return { code: 'NETWORK_ERROR', stage: 'upstream', key };
  if (err instanceof UpstreamError) {
    const step = (err.details as { step?: unknown } | undefined)?.step;
    const ssrf = (err.details as { code?: unknown } | undefined)?.code === 'SSRF_BLOCKED';
    return { code: ssrf ? 'SSRF_BLOCKED' : err.code, stage: step !== undefined ? 'composite' : 'upstream', key };
  }
  return { code: err.code, stage: (currentStage && STAGE_TO_ERROR[currentStage]) ?? 'internal', key };
}

/** Rule evaluation trace without the note params (they may echo argument values). */
function policyTrace(d: Decision, step?: string): unknown[] {
  return d.trace.map((t) => ({ ruleId: t.ruleId, effect: t.effect, matched: t.matched, note: t.note.key, ...(step ? { step } : {}) }));
}

const TOOL_KIND: Record<string, EventToolKind> = { openapi: 'openapi', manual: 'manual', composite: 'composite' };

export interface RecorderInit {
  kind: CallEventKind;
  toolName: string;
  callId?: string;
  parentCallId?: string;
  started?: number;
  toolKind?: EventToolKind;
}

/**
 * Collects one call's wide event (ADR-016 §1): identity from the context, timings per stage,
 * decisions, data counters and token estimates. The executor derives audit, metrics, span
 * attributes and the analytics row from `finish()`.
 */
export class CallRecorder {
  readonly callId: string;
  readonly started: number;
  readonly ev: CallEvent;
  /** Extra audit details (kept as before F15: deny reason/rule, composite calls, step index). */
  auditDetails: Record<string, unknown> | undefined;
  refs: SubjectRef[] = [];
  private current: Stage | undefined;
  private artifactSummaryBytes: number | undefined;
  /** Monotonic start: sub-millisecond latency for metrics (rows round to ms). */
  private readonly t0 = performance.now();

  constructor(ctx: CallContext, init: RecorderInit) {
    this.started = init.started ?? Date.now();
    this.callId = init.callId ?? uuidv7(this.started);
    const id = ctx.identity;
    const endpoint = id?.endpoint ?? 'mcp';
    this.ev = {
      v: 1,
      ts: new Date(this.started),
      callId: this.callId,
      parentCallId: init.parentCallId ?? null,
      tenantId: ctx.tenantId,
      tenantSlug: ctx.snapshot.tenant.slug,
      kind: init.kind,
      endpoint,
      subject: ctx.principal.sub,
      clientId: ctx.principal.clientId ?? null,
      agentName: id?.agentName ?? null,
      agentVersion: id?.agentVersion ?? null,
      sessionKey: ctx.sessionKey ?? null,
      sessionSource: id?.sessionSource ?? (ctx.sessionKey ? 'principal' : null),
      virtualServerId: ctx.virtualServer?.id ?? null,
      requestId: ctx.requestId ?? null,
      jsonrpcId: id?.jsonrpcId ?? null,
      protocolVersion: id?.protocolVersion ?? null,
      inboundParentSpanId: ctx.inboundTrace?.parentSpanId ?? null,
      toolName: init.toolName,
      toolKind: init.toolKind ?? null,
      viaOmni: endpoint === 'omni' || endpoint === 'server_omni',
      decision: 'allow',
      latencyMs: 0,
      stages: {},
    };
  }

  get decision(): CallEvent['decision'] {
    return this.ev.decision;
  }

  setTrace(traceId: string, spanId: string): void {
    this.ev.traceId = traceId;
    this.ev.spanId = spanId;
  }

  setTool(tool: SnapshotTool, defTokens?: number): void {
    this.ev.toolId = tool.id;
    this.ev.toolName = tool.name;
    this.ev.toolVersion = tool.version;
    this.ev.toolKind = TOOL_KIND[tool.kind] ?? null;
    this.ev.sourceId = tool.sourceId ?? null;
    if (defTokens !== undefined) this.ev.defTokens = defTokens;
  }

  addStage(stage: Stage, ms: number): void {
    const stages = (this.ev.stages ??= {});
    stages[stage] = (stages[stage] ?? 0) + Math.max(0, ms);
  }

  /** Times `fn` as part of `stage` (accumulates when a stage runs more than once). */
  async stage<T>(stage: Stage, fn: () => Promise<T> | T): Promise<T> {
    const t0 = performance.now();
    const previous = this.current;
    this.current = stage;
    try {
      return await fn();
    } finally {
      this.addStage(stage, performance.now() - t0);
      this.current = previous;
    }
  }

  /** Policy decision of the call (allow keeps the deciding rule too, F15.7). */
  policy(d: Decision, step?: string): void {
    this.ev.policyRuleId = d.ruleId ?? null;
    this.ev.policyReason = d.reason;
    if (d.effect !== 'allow') {
      this.ev.decision = 'deny';
      this.ev.policyTrace = policyTrace(d, step);
      this.auditDetails = { ...(this.auditDetails ?? {}), reason: d.reason, ruleId: d.ruleId ?? null, ...(step ? { step } : {}) };
    }
  }

  policyVersion(version: string): void {
    this.ev.policyVersion = version;
  }

  /** Explicit deny outside the policy evaluation of the call itself (visibility, composite pre-check). */
  deny(reason: string, details: Record<string, unknown> = {}): void {
    this.ev.decision = 'deny';
    this.ev.policyReason = reason;
    this.auditDetails = { ...(this.auditDetails ?? {}), reason, ...details };
  }

  /** Exception during the call. A deny keeps its decision; anything else becomes `error`. */
  fail(err: unknown): void {
    const c = classifyError(err, this.current);
    if (this.ev.decision === 'allow') this.ev.decision = c.stage === 'authz' ? 'deny' : 'error';
    this.ev.errorCode ??= c.code;
    this.ev.errorStage ??= c.stage;
    if (c.key) this.ev.errorKey ??= c.key;
  }

  /** A tool error result returned without an exception (e.g. upstream 4xx/5xx). */
  toolError(result: ToolResult): void {
    if (this.ev.decision === 'allow') this.ev.decision = 'error';
    if (!this.ev.errorCode) {
      const code = errorPayload(result).error;
      this.ev.errorCode = typeof code === 'string' ? code.slice(0, 64) : 'TOOL_ERROR';
    }
    this.ev.errorStage ??= this.ev.upstreamStatus && this.ev.upstreamStatus >= 400 ? 'upstream' : 'internal';
  }

  upstream(res: { status: number; attempts: number; bytes: number }): void {
    this.ev.upstreamStatus = res.status;
    this.ev.attempts = res.attempts;
    if (res.bytes) this.ev.upstreamBytes = res.bytes;
  }

  requestBytes(n: number): void {
    this.ev.requestBytes = n;
  }

  detokenized(n: number): void {
    this.ev.detokenizedCount = n;
  }

  redactions(count: number, byDetector: Record<string, number>): void {
    this.ev.redactionsCount = (this.ev.redactionsCount ?? 0) + count;
    if (count) {
      const merged = { ...(this.ev.redactionsByDetector ?? {}) };
      for (const [d, n] of Object.entries(byDetector)) merged[d] = (merged[d] ?? 0) + n;
      this.ev.redactionsByDetector = merged;
    }
  }

  projection(bytesBefore: number, bytesAfter: number, projectionId: string | undefined, agentFields: boolean): void {
    this.ev.bytesBeforeProjection = bytesBefore;
    this.ev.bytesAfterProjection = bytesAfter;
    this.ev.projection = { projectionId: projectionId ?? null, agentFields };
  }

  artifact(id: string, bytes: number, summaryBytes: number): void {
    this.ev.artifactId = id;
    this.ev.artifactBytes = bytes;
    this.artifactSummaryBytes = summaryBytes;
  }

  responseBytes(n: number): void {
    this.ev.responseBytes = n;
  }

  meta(meta: EventMeta): void {
    this.ev.meta = meta;
  }

  catalogTokens(n: number): void {
    this.ev.catalogTokens = n;
  }

  argsHash(hash: string): void {
    this.ev.argsHash = hash;
  }

  subjectRefs(refs: SubjectRef[], truncated: boolean): void {
    this.refs.push(...refs);
    this.ev.subjectRefsCount = this.refs.length;
    if (truncated) this.ev.subjectRefsTruncated = true;
  }

  /** Bytes the audit row reports as saved by projection (F6.2). */
  get projectedBytesSaved(): number {
    const { bytesBeforeProjection: b, bytesAfterProjection: a } = this.ev;
    return b != null && a != null ? Math.max(0, b - a) : 0;
  }

  /** Closes the event: total latency and token estimates (ADR-016 §11). */
  finish(now?: number): CallEvent {
    const ev = this.ev;
    ev.latencyMs = Math.max(0, now !== undefined ? now - this.started : performance.now() - this.t0);
    if (ev.responseBytes != null) ev.responseTokens = estimateTokens(ev.responseBytes);
    const raw = ev.bytesBeforeProjection ?? ev.upstreamBytes;
    if (raw != null) ev.rawTokens = estimateTokens(raw);
    ev.tokensSavedProjection = tokensSaved(ev.bytesBeforeProjection, ev.bytesAfterProjection);
    ev.tokensSavedArtifact = ev.artifactBytes != null ? tokensSaved(ev.artifactBytes, this.artifactSummaryBytes) : 0;
    return ev;
  }
}

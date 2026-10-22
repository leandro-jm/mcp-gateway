/**
 * Wide call event (ADR-016): one per call, with every dimension. Audit rows, metrics, span
 * attributes and analytics are derived from it. Never carries payloads, search queries or
 * free text: only counts, hashes, names and identifiers that are already sanitized.
 */

export type CallEventKind = 'tool' | 'composite_step' | 'meta' | 'list' | 'artifact' | 'outcome';

/** Where the call entered the gateway. */
export type CallEndpoint = 'mcp' | 'server' | 'omni' | 'server_omni' | 'playground' | 'observability' | 'api';

/** How the session key was obtained: client header, Omni dynamic session or the principal itself. */
export type SessionSource = 'header' | 'omni' | 'principal';

export type EventToolKind = 'openapi' | 'manual' | 'composite' | 'plugin' | 'meta' | 'artifact' | 'observability';

export type CallDecision = 'allow' | 'deny' | 'error';

export type ErrorStage =
  | 'authz'
  | 'validation'
  | 'rate_limit'
  | 'circuit'
  | 'upstream'
  | 'composite'
  | 'redaction'
  | 'projection'
  | 'artifact'
  | 'protocol'
  | 'internal';

/** Timed pipeline stages (milliseconds). `plugins` is the tool router (ADR-025). */
export const STAGES = ['authz', 'validation', 'pii', 'upstream', 'projection', 'artifact', 'plugins'] as const;
export type Stage = (typeof STAGES)[number];

/**
 * One tool router hook (ADR-025): rerank on `search_tools` (meta event), shortlist on
 * `tools/list` (list event) or gate on `tools/call`. Codes and counts only: never the query,
 * intent or arguments sent to the provider, nor raw probabilities.
 */
export interface PluginDecision {
  plugin: string;
  /** `applied`/`skipped` (rerank, shortlist) or the gate outcome. */
  decision: string;
  /** Closed set: ok, low_confidence, none_option, refusal, invalid, too_many, timeout, error, circuit_open, budget, no_intent, human_confirmed, disabled. */
  reason?: string;
  ms?: number;
  point?: 'rerank' | 'shortlist' | 'gate';
  provider?: string;
  model?: string;
  confidence?: 'low' | 'medium' | 'high';
  cached?: boolean;
  candidates?: number;
  kept?: number;
}

/** Tool router gate of a call (ADR-025); `required` = the gate ran for this tool. */
export interface GateDecision {
  required: boolean;
  outcome: 'allow' | 'confirm' | 'deny';
  reason?: string;
}

/** Reserved for cross-server data flow tracking (not built yet). */
export interface TaintInfo {
  origin?: string;
  destination?: string;
}

/**
 * Extra data of `meta` and `list` events: search results are tool names only, never the
 * query text; `fullCatalogTokens` is what the native catalog would cost (Omni savings).
 */
export interface EventMeta {
  queryHash?: string;
  results?: string[];
  tool?: string;
  fullCatalogTokens?: number;
  /**
   * Generative UI (ADR-022): `origin` is self-declared by the view (informative only); `phase`
   * is `input` when the call stopped at a form/confirmation instead of running.
   */
  ui?: { origin?: 'app'; phase: 'input' | 'result'; view?: string };
}

export interface CallEvent {
  v: 1;
  /** Start of the call. */
  ts: Date;
  /** UUIDv7 (time-ordered). */
  callId: string;
  parentCallId?: string | null;
  tenantId: string;
  /** Not persisted: used for metric labels and legacy span attributes. */
  tenantSlug?: string;
  kind: CallEventKind;
  endpoint: CallEndpoint;

  // identity
  /** Sanitized subject (never clear-text PII). */
  subject: string;
  clientId?: string | null;
  agentName?: string | null;
  agentVersion?: string | null;
  sessionKey?: string | null;
  sessionSource?: SessionSource | null;
  virtualServerId?: string | null;
  requestId?: string | null;
  jsonrpcId?: string | null;
  protocolVersion?: string | null;
  traceId?: string | null;
  spanId?: string | null;
  inboundParentSpanId?: string | null;

  // tool
  toolId?: string | null;
  toolName: string;
  toolVersion?: number | null;
  toolKind?: EventToolKind | null;
  sourceId?: string | null;
  viaOmni?: boolean;

  // outcome
  decision: CallDecision;
  errorCode?: string | null;
  errorStage?: ErrorStage | null;
  /** Message key only (params are never stored). */
  errorKey?: string | null;
  upstreamStatus?: number | null;
  attempts?: number | null;

  // decisions
  policyRuleId?: string | null;
  policyReason?: string | null;
  policyVersion?: string | null;
  /** Rule evaluation trace; only on deny (or debug capture). */
  policyTrace?: unknown[] | null;

  // data
  redactionsCount?: number;
  redactionsByDetector?: Record<string, number> | null;
  detokenizedCount?: number;
  requestBytes?: number | null;
  upstreamBytes?: number | null;
  bytesBeforeProjection?: number | null;
  bytesAfterProjection?: number | null;
  responseBytes?: number | null;
  projection?: { projectionId?: string | null; agentFields?: boolean } | null;
  artifactId?: string | null;
  artifactBytes?: number | null;
  subjectRefsCount?: number;
  subjectRefsTruncated?: boolean;
  meta?: EventMeta | null;
  /** HMAC of the canonical arguments: loop detection without storing arguments. */
  argsHash?: string | null;

  // performance
  latencyMs: number;
  stages?: Partial<Record<Stage, number>>;

  // context (estimated tokens, ADR-016 §11)
  defTokens?: number | null;
  responseTokens?: number | null;
  rawTokens?: number | null;
  tokensSavedProjection?: number;
  tokensSavedArtifact?: number;
  /** On `list` events: tokens of the advertised catalog. */
  catalogTokens?: number | null;

  // tool router (ADR-025); `taint` and `pinnedVersion` stay reserved (ADR-016 §2)
  plugins?: PluginDecision[] | null;
  gate?: GateDecision | null;
  taint?: TaintInfo | null;
  pinnedVersion?: string | null;
}

/** Gateway overhead: total latency minus the upstream share. */
export function overheadMs(ev: Pick<CallEvent, 'latencyMs' | 'stages'>): number {
  return Math.max(0, ev.latencyMs - (ev.stages?.upstream ?? 0));
}

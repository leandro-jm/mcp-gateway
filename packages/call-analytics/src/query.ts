import { msg, type ServerMessage } from '@mcp-gateway/i18n/server';

/**
 * Typed analytics query (ADR-016 §12). Metrics, dimensions and filters come from whitelists and
 * are compiled to SQL by the store; strings only ever reach the database as bound parameters.
 * Raw SQL is never accepted.
 */
export const METRICS = [
  'calls',
  'errors',
  'denies',
  'error_rate',
  'latency_avg',
  'latency_p50',
  'latency_p95',
  'latency_p99',
  'latency_max',
  'overhead_avg',
  'overhead_p95',
  'upstream_avg',
  'retries',
  'redactions',
  'bytes_saved_projection',
  'tokens_response',
  'tokens_saved',
  'tokens_saved_projection',
  'tokens_saved_artifact',
  'tokens_saved_omni',
  'agents',
  'clients',
  'authz_avg',
  'validation_avg',
  'pii_avg',
  'projection_avg',
  'artifact_avg',
  'success_rate',
] as const;
export type Metric = (typeof METRICS)[number];

export const DIMENSIONS = [
  'tool',
  'tool_kind',
  'source',
  'client',
  'agent',
  'virtual_server',
  'endpoint',
  'kind',
  'decision',
  'error_stage',
  'error_code',
  'hour',
  'day',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const FILTERS = ['tool', 'tool_kind', 'source', 'client', 'agent', 'virtual_server', 'endpoint', 'kind', 'decision', 'error_stage', 'error_code'] as const;
export type FilterKey = (typeof FILTERS)[number];

export const LAST = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 } as const;
export type LastRange = keyof typeof LAST;

export const MAX_GROUP_BY = 2;
export const MAX_RANGE_DAYS = 90;
export const MAX_LIMIT = 100;
const MAX_FILTER_VALUES = 50;
const MAX_FILTER_LENGTH = 200;

/** `success_rate` comes from reported outcomes (F15.22): only these dimensions and filters apply. */
export const OUTCOME_DIMENSIONS: ReadonlySet<Dimension> = new Set(['tool', 'virtual_server', 'day']);
export const OUTCOME_FILTERS: ReadonlySet<FilterKey> = new Set(['tool', 'virtual_server']);

/** Metrics about context savings look at every event kind (Omni savings live on `list` events). */
export const ALL_KINDS_METRICS: ReadonlySet<Metric> = new Set(['tokens_saved', 'tokens_saved_omni']);

export interface AnalyticsQuery {
  metric: Metric;
  groupBy?: Dimension[];
  filters?: Partial<Record<FilterKey, string | string[]>>;
  range: { last: LastRange } | { from: string; to: string };
  limit?: number;
  order?: 'asc' | 'desc';
}

/** Validated query with the time range resolved. */
export interface NormalizedQuery {
  metric: Metric;
  groupBy: Dimension[];
  filters: Partial<Record<FilterKey, string[]>>;
  from: Date;
  to: Date;
  limit: number;
  order: 'asc' | 'desc';
}

export interface QueryRow {
  /** Dimension values, in `groupBy` order (time dimensions as ISO strings). */
  keys: Record<string, string | null>;
  value: number | null;
}

export interface QueryResult {
  metric: Metric;
  groupBy: Dimension[];
  from: string;
  to: string;
  rows: QueryRow[];
}

export interface AnalyticsScope {
  /** Restricts the data to these tools (tool owners see only their own). */
  toolNames?: string[];
}

export type UsageDimension = 'subject' | 'client' | 'agent';

export interface UsageRow {
  key: string | null;
  calls: number;
  errors: number;
  denies: number;
  responseTokens: number;
  tokensSaved: number;
}

export interface DenialRow {
  ruleId: string | null;
  reason: string | null;
  tool: string;
  calls: number;
}

/** Read side of analytics (ADR-016 §3): Postgres rollups today, ClickHouse later. */
export interface AnalyticsStore {
  query(tenantId: string, q: NormalizedQuery, scope?: AnalyticsScope): Promise<QueryResult>;
  /** Redactions per detector in the range. */
  detectorCounts(tenantId: string, from: Date, to: Date, scope?: AnalyticsScope): Promise<Record<string, number>>;
  /** Chargeback: daily usage grouped by subject, client or agent. */
  usageBy(tenantId: string, by: UsageDimension, from: Date, to: Date, limit?: number): Promise<UsageRow[]>;
  /** Denials by policy rule and tool (raw events: kept as long as `call_events`). */
  denialsByRule(tenantId: string, from: Date, to: Date, limit?: number): Promise<DenialRow[]>;
}

export type QueryValidation = { ok: true; query: NormalizedQuery } | { ok: false; error: ServerMessage };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (error: ServerMessage): QueryValidation => ({ ok: false, error });

export function validateQuery(input: unknown, now: Date = new Date()): QueryValidation {
  if (!isObj(input)) return fail(msg('analytics.invalidQuery', { reason: 'object expected' }));
  for (const k of Object.keys(input)) {
    if (!['metric', 'groupBy', 'filters', 'range', 'limit', 'order'].includes(k)) return fail(msg('analytics.invalidQuery', { reason: `unknown field "${k.slice(0, 40)}"` }));
  }
  const metric = input.metric;
  if (typeof metric !== 'string' || !(METRICS as readonly string[]).includes(metric)) {
    return fail(msg('analytics.unknownMetric', { metric: String(metric).slice(0, 40), allowed: METRICS.join(', ') }));
  }

  const groupBy = input.groupBy ?? [];
  if (!Array.isArray(groupBy)) return fail(msg('analytics.invalidQuery', { reason: 'groupBy must be a list' }));
  if (groupBy.length > MAX_GROUP_BY) return fail(msg('analytics.tooManyGroupBy', { max: MAX_GROUP_BY }));
  for (const d of groupBy) {
    if (typeof d !== 'string' || !(DIMENSIONS as readonly string[]).includes(d)) {
      return fail(msg('analytics.unknownDimension', { dimension: String(d).slice(0, 40), allowed: DIMENSIONS.join(', ') }));
    }
  }
  if (new Set(groupBy).size !== groupBy.length) return fail(msg('analytics.invalidQuery', { reason: 'repeated dimension' }));

  const filters: Partial<Record<FilterKey, string[]>> = {};
  if (input.filters !== undefined) {
    if (!isObj(input.filters)) return fail(msg('analytics.invalidQuery', { reason: 'filters must be an object' }));
    for (const [k, v] of Object.entries(input.filters)) {
      if (!(FILTERS as readonly string[]).includes(k)) return fail(msg('analytics.unknownFilter', { filter: k.slice(0, 40), allowed: FILTERS.join(', ') }));
      const values = Array.isArray(v) ? v : [v];
      if (!values.length || values.length > MAX_FILTER_VALUES || !values.every((x) => typeof x === 'string' && x.length > 0 && x.length <= MAX_FILTER_LENGTH)) {
        return fail(msg('analytics.invalidFilterValue', { filter: k }));
      }
      filters[k as FilterKey] = values as string[];
    }
  }

  const range = input.range;
  let from: Date;
  let to: Date;
  if (isObj(range) && typeof range.last === 'string' && range.last in LAST && Object.keys(range).length === 1) {
    to = now;
    from = new Date(now.getTime() - LAST[range.last as LastRange]);
  } else if (isObj(range) && typeof range.from === 'string' && typeof range.to === 'string' && Object.keys(range).length === 2) {
    from = new Date(range.from);
    to = new Date(range.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return fail(msg('analytics.invalidRange'));
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) return fail(msg('analytics.rangeTooLarge', { days: MAX_RANGE_DAYS }));
  } else {
    return fail(msg('analytics.invalidRange'));
  }

  if (metric === 'success_rate') {
    const badDim = (groupBy as string[]).find((d) => !OUTCOME_DIMENSIONS.has(d as Dimension));
    const badFilter = Object.keys(filters).find((f) => !OUTCOME_FILTERS.has(f as FilterKey));
    if (badDim || badFilter) return fail(msg('analytics.invalidQuery', { reason: `success_rate supports groupBy/filters on ${[...OUTCOME_DIMENSIONS].join(', ')}` }));
  }

  const limit = input.limit ?? 20;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return fail(msg('analytics.invalidLimit', { max: MAX_LIMIT }));
  const order = input.order ?? 'desc';
  if (order !== 'asc' && order !== 'desc') return fail(msg('analytics.invalidQuery', { reason: 'order must be asc or desc' }));

  return { ok: true, query: { metric: metric as Metric, groupBy: groupBy as Dimension[], filters, from, to, limit, order } };
}

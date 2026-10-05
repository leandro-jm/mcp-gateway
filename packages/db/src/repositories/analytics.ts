import {
  ALL_KINDS_METRICS,
  histogramQuantile,
  LATENCY_BUCKETS_MS,
  type AnalyticsScope,
  type AnalyticsStore,
  type DenialRow,
  type Dimension,
  type FilterKey,
  type Metric,
  type NormalizedQuery,
  type QueryResult,
  type QueryRow,
  type UsageDimension,
  type UsageRow,
} from '@mcp-gateway/call-analytics';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../client';

/** Whitelisted SQL for each dimension (over `call_rollups_hourly`). */
const DIMENSION_SQL: Record<Dimension, string> = {
  tool: 'tool_name',
  tool_kind: 'tool_kind',
  source: 'source_id::text',
  client: 'client_id',
  agent: 'agent_name',
  virtual_server: 'virtual_server_id::text',
  endpoint: 'endpoint',
  kind: 'kind',
  decision: 'decision',
  error_stage: 'error_stage',
  error_code: 'error_code',
  hour: "date_trunc('hour', bucket)",
  day: "date_trunc('day', bucket)",
};

const FILTER_SQL: Record<FilterKey, string> = {
  tool: 'tool_name',
  tool_kind: 'tool_kind',
  source: 'source_id::text',
  client: 'client_id',
  agent: 'agent_name',
  virtual_server: 'virtual_server_id::text',
  endpoint: 'endpoint',
  kind: 'kind',
  decision: 'decision',
  error_stage: 'error_stage',
  error_code: 'error_code',
};

const ratio = (num: string) => `(${num})::float8 / nullif(sum(calls), 0)`;

/** Whitelisted aggregate for each metric; percentiles come from the summed histogram. */
const METRIC_SQL: Record<Metric, string> = {
  calls: 'sum(calls)',
  errors: "coalesce(sum(calls) FILTER (WHERE decision = 'error'), 0)",
  denies: "coalesce(sum(calls) FILTER (WHERE decision = 'deny'), 0)",
  error_rate: ratio("coalesce(sum(calls) FILTER (WHERE decision = 'error'), 0)"),
  latency_avg: ratio('sum(latency_sum)'),
  latency_p50: 'NULL',
  latency_p95: 'NULL',
  latency_p99: 'NULL',
  latency_max: 'max(latency_max)',
  overhead_avg: ratio('sum(overhead_sum)'),
  overhead_p95: 'NULL',
  upstream_avg: ratio('sum(upstream_sum)'),
  retries: 'sum(retries_sum)',
  redactions: 'sum(redactions_sum)',
  bytes_saved_projection: 'sum(greatest(bytes_before_sum - bytes_after_sum, 0))',
  tokens_response: 'sum(response_tokens_sum)',
  tokens_saved: 'sum(tokens_saved_projection_sum + tokens_saved_artifact_sum + tokens_saved_omni_sum)',
  tokens_saved_projection: 'sum(tokens_saved_projection_sum)',
  tokens_saved_artifact: 'sum(tokens_saved_artifact_sum)',
  tokens_saved_omni: 'sum(tokens_saved_omni_sum)',
  agents: 'count(DISTINCT agent_name)',
  clients: 'count(DISTINCT client_id)',
  authz_avg: ratio('sum(authz_sum)'),
  validation_avg: ratio('sum(validation_sum)'),
  pii_avg: ratio('sum(pii_sum)'),
  projection_avg: ratio('sum(projection_sum)'),
  artifact_avg: ratio('sum(artifact_sum)'),
  success_rate: 'NULL',
};

const QUANTILE: Partial<Record<Metric, { q: number; column: string }>> = {
  latency_p50: { q: 0.5, column: 'latency_buckets' },
  latency_p95: { q: 0.95, column: 'latency_buckets' },
  latency_p99: { q: 0.99, column: 'latency_buckets' },
  overhead_p95: { q: 0.95, column: 'overhead_buckets' },
};

const TIME_DIMENSIONS: ReadonlySet<Dimension> = new Set(['hour', 'day']);
const MAX_GROUPS_IN_MEMORY = 5000;

/** Element-wise sum of a histogram column, in SQL (Postgres arrays are 1-based). */
const histogramSum = (column: string) => `ARRAY[${Array.from({ length: LATENCY_BUCKETS_MS.length + 1 }, (_, i) => `coalesce(sum(${column}[${i + 1}]), 0)`).join(', ')}]`;

/**
 * Read side of analytics over the hourly rollups (F15.9). The query is already validated
 * (`validateQuery`); every identifier comes from the whitelists above and every value is a
 * bound parameter.
 */
export class PgAnalyticsStore implements AnalyticsStore {
  constructor(private readonly db: Db) {}

  async query(tenantId: string, q: NormalizedQuery, scope: AnalyticsScope = {}): Promise<QueryResult> {
    if (q.metric === 'success_rate') return this.successRate(tenantId, q, scope);
    const conds: SQL[] = [sql`tenant_id = ${tenantId}`, sql`bucket >= date_trunc('hour', ${q.from}::timestamptz)`, sql`bucket < ${q.to}`];
    if (!q.filters.kind && !ALL_KINDS_METRICS.has(q.metric)) conds.push(sql`kind = 'tool'`);
    for (const [key, values] of Object.entries(q.filters) as Array<[FilterKey, string[]]>) {
      conds.push(sql`${sql.raw(FILTER_SQL[key])} = ANY(${sql.param(values)}::text[])`);
    }
    if (scope.toolNames) conds.push(sql`tool_name = ANY(${sql.param(scope.toolNames)}::text[])`);

    const dims = q.groupBy.map((d, i) => `${DIMENSION_SQL[d]} AS d${i}`);
    const quantile = QUANTILE[q.metric];
    const select = [...dims, `${METRIC_SQL[q.metric]} AS value`, 'count(*) AS n', ...(quantile ? [`${histogramSum(quantile.column)} AS hist`] : [])].join(', ');
    const groupBy = q.groupBy.length ? sql.raw(` GROUP BY ${q.groupBy.map((d) => DIMENSION_SQL[d]).join(', ')}`) : sql.raw('');
    const timeOrder = q.groupBy.some((d) => TIME_DIMENSIONS.has(d));
    // percentiles are computed after the query: sort and cut in memory
    const order = quantile
      ? sql.raw(` LIMIT ${MAX_GROUPS_IN_MEMORY}`)
      : timeOrder
        ? sql.raw(` ORDER BY ${q.groupBy.map((_, i) => `d${i}`).join(', ')} LIMIT ${MAX_GROUPS_IN_MEMORY}`)
        : sql.raw(` ORDER BY value ${q.order === 'asc' ? 'ASC' : 'DESC'} NULLS LAST LIMIT ${q.limit}`);

    const res = await this.db.execute<Record<string, unknown>>(
      sql`SELECT ${sql.raw(select)} FROM call_rollups_hourly WHERE ${sql.join(conds, sql` AND `)}${groupBy}${order}`,
    );

    // an aggregate without GROUP BY returns one row even when nothing matched
    let rows: QueryRow[] = res.rows.filter((r) => Number(r.n) > 0).map((r) => {
      const keys: Record<string, string | null> = {};
      q.groupBy.forEach((d, i) => {
        const v = r[`d${i}`];
        keys[d] = v == null ? null : TIME_DIMENSIONS.has(d) ? new Date(v as string | Date).toISOString() : String(v);
      });
      const value = quantile ? histogramQuantile(quantile.q, (r.hist as Array<number | string>).map(Number)) : r.value == null ? null : Number(r.value);
      return { keys, value: value === null ? null : Math.round(value * 1000) / 1000 };
    });
    if (quantile && !timeOrder) {
      rows.sort((a, b) => (q.order === 'asc' ? 1 : -1) * ((a.value ?? -Infinity) - (b.value ?? -Infinity)));
    }
    if (quantile || timeOrder) rows = rows.slice(0, timeOrder ? MAX_GROUPS_IN_MEMORY : q.limit);
    return { metric: q.metric, groupBy: q.groupBy, from: q.from.toISOString(), to: q.to.toISOString(), rows };
  }

  async detectorCounts(tenantId: string, from: Date, to: Date, scope: AnalyticsScope = {}): Promise<Record<string, number>> {
    const tools = scope.toolNames ? sql` AND tool_name = ANY(${sql.param(scope.toolNames)}::text[])` : sql``;
    const res = await this.db.execute<{ det: Record<string, string | number> | null }>(
      sql`SELECT jsonb_counts_sum(redactions_by_detector) AS det FROM call_rollups_hourly
          WHERE tenant_id = ${tenantId} AND bucket >= date_trunc('hour', ${from}::timestamptz) AND bucket < ${to}${tools}`,
    );
    return Object.fromEntries(Object.entries(res.rows[0]?.det ?? {}).map(([k, v]) => [k, Number(v)]));
  }

  async usageBy(tenantId: string, by: UsageDimension, from: Date, to: Date, limit = 50): Promise<UsageRow[]> {
    const col = sql.raw({ subject: 'subject', client: 'client_id', agent: 'agent_name' }[by]);
    const res = await this.db.execute<Record<string, string | number | null>>(
      sql`SELECT ${col} AS key, sum(calls)::bigint AS calls, sum(errors)::bigint AS errors, sum(denies)::bigint AS denies,
                 sum(response_tokens_sum)::bigint AS tokens, sum(tokens_saved_sum)::bigint AS saved
          FROM usage_rollups_daily
          WHERE tenant_id = ${tenantId} AND day >= (${from}::timestamptz AT TIME ZONE 'UTC')::date AND day <= (${to}::timestamptz AT TIME ZONE 'UTC')::date
          GROUP BY ${col} ORDER BY sum(calls) DESC LIMIT ${Math.min(Math.max(limit, 1), 500)}`,
    );
    return res.rows.map((r) => ({
      key: r.key == null ? null : String(r.key),
      calls: Number(r.calls),
      errors: Number(r.errors),
      denies: Number(r.denies),
      responseTokens: Number(r.tokens),
      tokensSaved: Number(r.saved),
    }));
  }

  async denialsByRule(tenantId: string, from: Date, to: Date, limit = 50): Promise<DenialRow[]> {
    const res = await this.db.execute<{ rule_id: string | null; reason: string | null; tool: string; calls: string | number }>(
      sql`SELECT policy_rule_id AS rule_id, policy_reason AS reason, tool_name AS tool, count(*) AS calls
          FROM call_events
          WHERE tenant_id = ${tenantId} AND ts >= ${from} AND ts < ${to} AND decision = 'deny' AND kind IN ('tool', 'composite_step')
          GROUP BY policy_rule_id, policy_reason, tool_name ORDER BY count(*) DESC LIMIT ${Math.min(Math.max(limit, 1), 500)}`,
    );
    return res.rows.map((r) => ({ ruleId: r.rule_id, reason: r.reason, tool: r.tool, calls: Number(r.calls) }));
  }

  /** Share of reported outcomes that were `success` (F15.22), per tool, virtual server or day. */
  private async successRate(tenantId: string, q: NormalizedQuery, scope: AnalyticsScope): Promise<QueryResult> {
    const DIM: Partial<Record<Dimension, string>> = { tool: 't.tool', virtual_server: 'o.virtual_server_id::text', day: "date_trunc('day', o.ts)" };
    const needsTools = q.groupBy.includes('tool') || Boolean(q.filters.tool) || Boolean(scope.toolNames);
    const conds: SQL[] = [sql`o.tenant_id = ${tenantId}`, sql`o.ts >= ${q.from}`, sql`o.ts < ${q.to}`];
    if (q.filters.tool) conds.push(sql`t.tool = ANY(${sql.param(q.filters.tool)}::text[])`);
    if (q.filters.virtual_server) conds.push(sql`o.virtual_server_id::text = ANY(${sql.param(q.filters.virtual_server)}::text[])`);
    if (scope.toolNames) conds.push(sql`t.tool = ANY(${sql.param(scope.toolNames)}::text[])`);
    const dims = q.groupBy.map((d, i) => `${DIM[d]} AS d${i}`);
    const select = [...dims, "count(*) FILTER (WHERE o.outcome = 'success')::float8 / nullif(count(*), 0) AS value", 'count(*) AS n'].join(', ');
    const from = needsTools ? sql.raw('call_outcomes o CROSS JOIN LATERAL unnest(o.tools) AS t(tool)') : sql.raw('call_outcomes o');
    const groupBy = q.groupBy.length ? sql.raw(` GROUP BY ${q.groupBy.map((d) => DIM[d]).join(', ')}`) : sql.raw('');
    const order = q.groupBy.includes('day') ? sql.raw(` ORDER BY ${q.groupBy.map((_, i) => `d${i}`).join(', ')}`) : sql.raw(` ORDER BY value ${q.order === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`);
    const res = await this.db.execute<Record<string, unknown>>(sql`SELECT ${sql.raw(select)} FROM ${from} WHERE ${sql.join(conds, sql` AND `)}${groupBy}${order} LIMIT ${q.limit}`);
    const rows: QueryRow[] = res.rows
      .filter((r) => Number(r.n) > 0)
      .map((r) => {
        const keys: Record<string, string | null> = {};
        q.groupBy.forEach((d, i) => {
          const v = r[`d${i}`];
          keys[d] = v == null ? null : d === 'day' ? new Date(v as string).toISOString() : String(v);
        });
        return { keys, value: r.value == null ? null : Math.round(Number(r.value) * 1000) / 1000 };
      });
    return { metric: q.metric, groupBy: q.groupBy, from: q.from.toISOString(), to: q.to.toISOString(), rows };
  }
}

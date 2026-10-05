import { LATENCY_BUCKETS_MS } from '@mcp-gateway/call-analytics';
import { sql } from 'drizzle-orm';
import type { Db } from '../client';

const HOUR = 3_600_000;
const LOCK_KEY = 727_275;
const WATERMARK = 'call_rollups';
/** Events may arrive this late (batched writer, retries) and still land in their hour. */
const LATE_MS = 2 * 60_000;
/** The range is recomputed in chunks of this size (bounded statements on a first catch-up). */
const CHUNK_MS = 24 * HOUR;

/** Non-cumulative histogram of an integer column with the `LATENCY_BUCKETS_MS` edges + overflow. */
function histogram(col: string): string {
  const parts: string[] = [];
  let prev: number | undefined;
  for (const edge of LATENCY_BUCKETS_MS) {
    parts.push(`count(*) FILTER (WHERE ${col} ${prev === undefined ? '' : `> ${prev} AND ${col} `}<= ${edge})`);
    prev = edge;
  }
  parts.push(`count(*) FILTER (WHERE ${col} > ${prev})`);
  return `ARRAY[${parts.join(', ')}]::int[]`;
}

const GROUP_COLS = [
  'tenant_id',
  'kind',
  'endpoint',
  'tool_name',
  'tool_id',
  'tool_kind',
  'source_id',
  'client_id',
  'agent_name',
  'virtual_server_id',
  'decision',
  'error_stage',
  'error_code',
];

const HOURLY_SQL = `
INSERT INTO call_rollups_hourly (
  ${GROUP_COLS.join(', ')}, bucket,
  calls, latency_sum, latency_max, latency_buckets, overhead_sum, overhead_buckets,
  upstream_sum, authz_sum, validation_sum, pii_sum, projection_sum, artifact_sum, retries_sum,
  redactions_sum, redactions_by_detector, bytes_before_sum, bytes_after_sum, artifact_bytes_sum,
  response_tokens_sum, raw_tokens_sum, def_tokens_sum,
  tokens_saved_projection_sum, tokens_saved_artifact_sum, tokens_saved_omni_sum
)
SELECT
  ${GROUP_COLS.join(', ')}, date_trunc('hour', ts) AS bucket,
  count(*)::int,
  coalesce(sum(latency_ms), 0),
  coalesce(max(latency_ms), 0),
  ${histogram('latency_ms')},
  coalesce(sum(overhead_ms), 0),
  ${histogram('overhead_ms')},
  coalesce(sum(upstream_ms), 0),
  coalesce(sum(authz_ms), 0),
  coalesce(sum(validation_ms), 0),
  coalesce(sum(pii_ms), 0),
  coalesce(sum(projection_ms), 0),
  coalesce(sum(artifact_ms), 0),
  coalesce(sum(greatest(coalesce(attempts, 1) - 1, 0)), 0),
  coalesce(sum(redactions_count), 0),
  nullif(jsonb_counts_sum(redactions_by_detector), '{}'::jsonb),
  coalesce(sum(bytes_before_projection), 0),
  coalesce(sum(bytes_after_projection), 0),
  coalesce(sum(artifact_bytes), 0),
  coalesce(sum(response_tokens), 0),
  coalesce(sum(raw_tokens), 0),
  coalesce(sum(def_tokens), 0),
  coalesce(sum(tokens_saved_projection), 0),
  coalesce(sum(tokens_saved_artifact), 0),
  coalesce(sum(CASE WHEN kind = 'list' AND via_omni
    THEN greatest(coalesce((meta->>'fullCatalogTokens')::int, 0) - coalesce(catalog_tokens, 0), 0) ELSE 0 END), 0)
FROM call_events`;
const HOURLY_GROUP = `GROUP BY ${GROUP_COLS.join(', ')}, date_trunc('hour', ts)`;

const DAILY_SQL = `
INSERT INTO usage_rollups_daily (tenant_id, day, subject, client_id, agent_name, calls, errors, denies, latency_sum, response_tokens_sum, tokens_saved_sum)
SELECT tenant_id, (ts AT TIME ZONE 'UTC')::date, subject, client_id, agent_name,
  count(*) FILTER (WHERE kind IN ('tool', 'artifact'))::int,
  count(*) FILTER (WHERE kind IN ('tool', 'artifact') AND decision = 'error')::int,
  count(*) FILTER (WHERE kind IN ('tool', 'artifact') AND decision = 'deny')::int,
  coalesce(sum(latency_ms) FILTER (WHERE kind IN ('tool', 'artifact')), 0),
  coalesce(sum(response_tokens) FILTER (WHERE kind <> 'composite_step'), 0),
  coalesce(sum(tokens_saved_projection + tokens_saved_artifact), 0)
FROM call_events`;
const DAILY_GROUP = `GROUP BY tenant_id, (ts AT TIME ZONE 'UTC')::date, subject, client_id, agent_name`;

export interface RollupReport {
  skipped: boolean;
  from?: Date;
  to?: Date;
  hours: number;
}

const floorHour = (t: number) => Math.floor(t / HOUR) * HOUR;
const floorDayUtc = (t: number) => Math.floor(t / (24 * HOUR)) * 24 * HOUR;

/**
 * Maintains the analytics rollups (F15.8) for every tenant. Runs under an advisory lock (several
 * replicas run maintenance) and a watermark: every hour from the watermark up to the current
 * (partial) hour is recomputed with delete + insert, so reruns are idempotent and late events
 * are picked up. Never exposed by the Admin API. @cross-tenant
 */
export class RollupWriter {
  constructor(private readonly db: Db) {}

  async rollup(now: Date = new Date(), initialLookbackMs = 30 * 24 * HOUR): Promise<RollupReport> {
    return this.db.transaction(async (tx) => {
      const lock = await tx.execute<{ ok: boolean }>(sql`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS ok`);
      if (!lock.rows[0]?.ok) return { skipped: true, hours: 0 };
      const wm = await tx.execute<{ upto: Date }>(sql`SELECT upto FROM analytics_watermarks WHERE name = ${WATERMARK}`);
      const nowMs = now.getTime();
      const start = floorHour(wm.rows[0] ? new Date(wm.rows[0].upto).getTime() : nowMs - initialLookbackMs);
      const end = floorHour(nowMs) + HOUR;
      const from = new Date(start);
      const to = new Date(end);

      for (let chunk = start; chunk < end; chunk += CHUNK_MS) {
        const a = new Date(chunk);
        const b = new Date(Math.min(chunk + CHUNK_MS, end));
        await tx.execute(sql`DELETE FROM call_rollups_hourly WHERE bucket >= ${a} AND bucket < ${b}`);
        await tx.execute(sql`${sql.raw(HOURLY_SQL)} WHERE ts >= ${a} AND ts < ${b} ${sql.raw(HOURLY_GROUP)}`);
      }

      // daily usage: whole UTC days touched by the range
      const dayFrom = new Date(floorDayUtc(start));
      const dayTo = new Date(floorDayUtc(end - 1) + 24 * HOUR);
      await tx.execute(sql`DELETE FROM usage_rollups_daily WHERE day >= ${dayFrom.toISOString().slice(0, 10)}::date AND day < ${dayTo.toISOString().slice(0, 10)}::date`);
      await tx.execute(sql`${sql.raw(DAILY_SQL)} WHERE ts >= ${dayFrom} AND ts < ${dayTo} AND kind <> 'composite_step' ${sql.raw(DAILY_GROUP)}`);

      // the next run restarts from the hour that may still receive late events
      const next = new Date(Math.min(floorHour(nowMs - LATE_MS), end));
      await tx.execute(sql`
        INSERT INTO analytics_watermarks (name, upto, updated_at) VALUES (${WATERMARK}, ${next}, now())
        ON CONFLICT (name) DO UPDATE SET upto = excluded.upto, updated_at = now()`);
      return { skipped: false, from, to, hours: (end - start) / HOUR };
    });
  }

  /** Drops rollups older than the retention (in days). */
  async prune(retentionDays: number, now: Date = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - retentionDays * 24 * HOUR);
    await this.db.execute(sql`DELETE FROM call_rollups_hourly WHERE bucket < ${cutoff}`);
    await this.db.execute(sql`DELETE FROM usage_rollups_daily WHERE day < ${cutoff.toISOString().slice(0, 10)}::date`);
  }
}

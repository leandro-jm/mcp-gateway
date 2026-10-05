import { histogramQuantile, uuidv7, type CallEvent } from '@mcp-gateway/call-analytics';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallEventWriter, RollupWriter, TenantsRepo } from '../src';
import { setupTestDb, type TestDb } from './helpers';

const HOUR = 3_600_000;

describe('analytics rollups (F15.8)', () => {
  let db: TestDb;
  let writer: CallEventWriter;
  let rollups: RollupWriter;
  let tenantId: string;
  // a fixed "now" at 10 minutes past an hour, 3 hours of data before it
  const now = new Date(Math.floor(Date.now() / HOUR) * HOUR + 10 * 60_000);
  const hour = (h: number, min = 5) => new Date(now.getTime() - 10 * 60_000 - h * HOUR + min * 60_000);

  const ev = (ts: Date, over: Partial<CallEvent> = {}): CallEvent => ({
    v: 1,
    ts,
    callId: uuidv7(ts.getTime()),
    tenantId,
    kind: 'tool',
    endpoint: 'mcp',
    subject: 'agent-a',
    clientId: 'bot',
    toolName: 'rh_colaborador_get',
    decision: 'allow',
    latencyMs: 20,
    stages: { upstream: 15 },
    responseTokens: 10,
    redactionsCount: 1,
    redactionsByDetector: { cpf: 1 },
    ...over,
  });

  const sums = async () =>
    (
      await db.pool.query(
        `SELECT sum(calls)::int AS calls, sum(latency_sum)::int AS latency, sum(redactions_sum)::int AS redactions,
                jsonb_counts_sum(redactions_by_detector) AS det, sum(tokens_saved_omni_sum)::int AS omni
         FROM call_rollups_hourly WHERE tenant_id = $1`,
        [tenantId],
      )
    ).rows[0];

  beforeAll(async () => {
    db = await setupTestDb();
    writer = new CallEventWriter(db.db);
    rollups = new RollupWriter(db.db);
    tenantId = (await new TenantsRepo(db.db).create({ slug: 'r', name: 'R' })).id;
    const events: CallEvent[] = [];
    for (let h = 0; h < 3; h++) {
      for (let i = 0; i < 10; i++) events.push(ev(hour(h, i), { latencyMs: i < 9 ? 20 : 400 }));
    }
    events.push(ev(hour(1), { decision: 'error', errorStage: 'upstream', errorCode: 'UPSTREAM_ERROR', redactionsByDetector: { email: 2 }, redactionsCount: 2 }));
    events.push(ev(hour(0), { kind: 'list', toolName: 'tools/list', endpoint: 'omni', viaOmni: true, catalogTokens: 100, meta: { fullCatalogTokens: 900 } }));
    await writer.insertBatch(events);
  });
  afterAll(async () => db?.teardown());

  it('hourly totals equal the sums over raw events, with detector counts and Omni savings', async () => {
    const r = await rollups.rollup(now, 6 * HOUR);
    expect(r.skipped).toBe(false);
    const raw = (await db.pool.query('SELECT count(*)::int AS n, sum(latency_ms)::int AS l, sum(redactions_count)::int AS red FROM call_events WHERE tenant_id = $1', [tenantId])).rows[0];
    expect(await sums()).toMatchObject({ calls: raw.n, latency: raw.l, redactions: raw.red, det: { cpf: 31, email: 2 }, omni: 800 });
    const buckets = (await db.pool.query('SELECT DISTINCT bucket FROM call_rollups_hourly WHERE tenant_id = $1', [tenantId])).rows;
    expect(buckets).toHaveLength(3);
    const errs = (await db.pool.query("SELECT calls, error_code FROM call_rollups_hourly WHERE decision = 'error'")).rows;
    expect(errs).toEqual([{ calls: 1, error_code: 'UPSTREAM_ERROR' }]);
  });

  it('is idempotent and picks up late events in their hour', async () => {
    const before = await sums();
    await rollups.rollup(now, 6 * HOUR);
    expect(await sums()).toEqual(before);
    // a late event for the previous hour (the watermark keeps it in range for 2 minutes)
    await writer.insertBatch([ev(hour(0, 1))]);
    await rollups.rollup(new Date(now.getTime() + 60_000), 6 * HOUR);
    expect((await sums()).calls).toBe(before.calls + 1);
  });

  it('estimates p95 from the histogram within one bucket', async () => {
    const rows = (await db.pool.query("SELECT latency_buckets FROM call_rollups_hourly WHERE tenant_id = $1 AND kind = 'tool' AND decision = 'allow'", [tenantId])).rows;
    const merged = rows.reduce((acc: number[], r) => acc.map((n, i) => n + (r.latency_buckets[i] ?? 0)), new Array(13).fill(0));
    expect(histogramQuantile(0.5, merged)).toBeLessThanOrEqual(25);
    expect(histogramQuantile(0.95, merged)).toBeGreaterThan(250);
    expect(histogramQuantile(0.95, merged)).toBeLessThanOrEqual(500);
  });

  it('daily usage per subject and client (chargeback)', async () => {
    const rows = (await db.pool.query('SELECT sum(calls)::int AS calls, sum(errors)::int AS errors, sum(response_tokens_sum)::int AS tokens FROM usage_rollups_daily WHERE tenant_id = $1', [tenantId])).rows[0];
    expect(rows.calls).toBe(32); // tool calls only, late event included (the list event is not a call)
    expect(rows.errors).toBe(1);
    expect(rows.tokens).toBeGreaterThan(0);
  });

  it('two concurrent runs do the work once', async () => {
    const [a, b] = await Promise.all([rollups.rollup(now, 6 * HOUR), rollups.rollup(now, 6 * HOUR)]);
    expect([a.skipped, b.skipped].filter(Boolean).length).toBeLessThanOrEqual(1);
    expect((await sums()).calls).toBe(33);
  });
});

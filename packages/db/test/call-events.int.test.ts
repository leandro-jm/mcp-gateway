import { uuidv7, type CallEvent } from '@mcp-gateway/call-analytics';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallEventsRepo, CallEventWriter, SystemQueries, TenantsRepo } from '../src';
import { setupTestDb, type TestDb } from './helpers';

const DAY = 86_400_000;

function event(tenantId: string, over: Partial<CallEvent> = {}): CallEvent {
  const ts = over.ts ?? new Date();
  return {
    v: 1,
    ts,
    callId: uuidv7(ts.getTime()),
    tenantId,
    kind: 'tool',
    endpoint: 'mcp',
    subject: 'agent',
    toolName: 'rh_colaborador_get',
    decision: 'allow',
    latencyMs: 120,
    stages: { upstream: 100, authz: 2 },
    ...over,
  };
}

describe('call_events (F15.5)', () => {
  let db: TestDb;
  let writer: CallEventWriter;
  let repo: CallEventsRepo;
  let system: SystemQueries;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    db = await setupTestDb();
    writer = new CallEventWriter(db.db);
    repo = new CallEventsRepo(db.db);
    system = new SystemQueries(db.db);
    const tenants = new TenantsRepo(db.db);
    tenantA = (await tenants.create({ slug: 'a', name: 'A' })).id;
    tenantB = (await tenants.create({ slug: 'b', name: 'B' })).id;
  });
  afterAll(async () => db?.teardown());

  it('writes a batch and reads by id (tenant-scoped), with generated overhead and reserved fields null', async () => {
    const parent = event(tenantA, { kind: 'tool', toolKind: 'composite', redactionsByDetector: { cpf: 2 } });
    const step = event(tenantA, { kind: 'composite_step', parentCallId: parent.callId, toolName: 'rh_escalas_list' });
    expect(await writer.insertBatch([parent, step, event(tenantB)])).toBe(3);

    const row = await repo.get(tenantA, parent.callId);
    expect(row).toMatchObject({ toolKind: 'composite', latencyMs: 120, upstreamMs: 100, overheadMs: 20, redactionsByDetector: { cpf: 2 }, plugins: null, gate: null, taint: null });
    expect(await repo.get(tenantB, parent.callId)).toBeUndefined();
    expect((await repo.children(tenantA, parent.callId)).map((r) => r.callId)).toEqual([step.callId]);
  });

  it('lists newest first with keyset pagination and filters', async () => {
    const base = Date.now() - 10_000;
    const evs = [0, 1, 2, 3].map((i) => event(tenantA, { ts: new Date(base + i * 1000), toolName: 'paged_tool', decision: i % 2 ? 'error' : 'allow' }));
    await writer.insertBatch(evs);
    const page1 = await repo.list(tenantA, { toolName: 'paged_tool', limit: 2 });
    expect(page1.map((r) => r.callId)).toEqual([evs[3]!.callId, evs[2]!.callId]);
    const page2 = await repo.list(tenantA, { toolName: 'paged_tool', limit: 2, before: { ts: page1[1]!.ts, callId: page1[1]!.callId } });
    expect(page2.map((r) => r.callId)).toEqual([evs[1]!.callId, evs[0]!.callId]);
    expect((await repo.list(tenantA, { toolName: 'paged_tool', decision: 'error' })).length).toBe(2);
    expect(await repo.list(tenantB, { toolName: 'paged_tool' })).toEqual([]);
  });

  it('creates partitions ahead, keeps out-of-range events in the default partition and drops old ones', async () => {
    const created = await system.ensureCallEventPartitions(3);
    expect(created).toHaveLength(4);
    expect(created.every((p) => /^call_events_p\d{8}$/.test(p))).toBe(true);

    // far in the past: no daily partition, lands in the default partition
    const old = event(tenantA, { ts: new Date(Date.now() - 400 * DAY) });
    await writer.insertBatch([old]);
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM call_events_default WHERE call_id = $1', [old.callId]);
    expect(rows[0].n).toBe(1);

    // a partition 40 days old is dropped with a 30-day retention
    const day = new Date(Date.now() - 40 * DAY);
    await db.pool.query('SELECT call_events_ensure_partition($1::date)', [day.toISOString().slice(0, 10)]);
    const dropped = await system.dropCallEventPartitionsOlderThan(30);
    expect(dropped).toContain(`call_events_p${day.toISOString().slice(0, 10).replace(/-/g, '')}`);
    expect(dropped.some((p) => created.includes(p))).toBe(false);
  });
});

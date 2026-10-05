import { uuidv7, type CallEvent } from '@mcp-gateway/call-analytics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchingCallEventSink, type QueuedCallEvent } from '../src/telemetry/call-events/sink';
import { Metrics } from '../src/telemetry/metrics';

const ev = (): CallEvent => ({
  v: 1,
  ts: new Date(),
  callId: uuidv7(),
  tenantId: 't',
  kind: 'tool',
  endpoint: 'mcp',
  subject: 's',
  toolName: 'x',
  decision: 'allow',
  latencyMs: 1,
});

async function metricValue(m: Metrics, name: string, label?: string): Promise<number> {
  const metric = (await m.registry.getMetricsAsJSON()).find((x) => x.name === name)!;
  const values = metric.values as Array<{ value: number; labels: Record<string, string> }>;
  return values.filter((v) => !label || v.labels.reason === label).reduce((a, v) => a + v.value, 0);
}

describe('BatchingCallEventSink (F15.6)', () => {
  let metrics: Metrics;
  let batches: QueuedCallEvent[][];
  let sinks: BatchingCallEventSink[];

  beforeEach(() => {
    vi.useFakeTimers();
    metrics = new Metrics();
    batches = [];
    sinks = [];
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const s of sinks) await s.close();
  });

  const make = (over: Partial<ConstructorParameters<typeof BatchingCallEventSink>[0]> = {}) => {
    const s = new BatchingCallEventSink({
      writeBatch: async (b) => void batches.push(b),
      flushMs: 1000,
      batchSize: 3,
      bufferMax: 5,
      metrics,
      ...over,
    });
    sinks.push(s);
    return s;
  };

  it('flushes when the batch is full', async () => {
    const s = make();
    for (let i = 0; i < 3; i++) s.write(ev());
    await s.flush();
    expect(batches.map((b) => b.length)).toEqual([3]);
    expect(await metricValue(metrics, 'mcp_call_events_written_total')).toBe(3);
  });

  it('flushes on the timer', async () => {
    make().write(ev());
    expect(batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(batches.map((b) => b.length)).toEqual([1]);
  });

  it('runs one flush at a time and drains everything in batches', async () => {
    let release!: () => void;
    let calls = 0;
    const s = make({
      writeBatch: async (b) => {
        calls++;
        if (calls === 1) await new Promise<void>((r) => (release = r));
        batches.push(b);
      },
      bufferMax: 100,
    });
    for (let i = 0; i < 3; i++) s.write(ev()); // triggers flush #1 (blocked)
    for (let i = 0; i < 4; i++) s.write(ev());
    const p = s.flush(); // same in-flight flush
    release();
    await p;
    await s.flush();
    expect(batches.map((b) => b.length).reduce((a, n) => a + n, 0)).toBe(7);
    expect(Math.max(...batches.map((b) => b.length))).toBeLessThanOrEqual(3);
  });

  it('drops (and counts) events when the buffer is full', async () => {
    const s = make({ batchSize: 100, bufferMax: 5 });
    for (let i = 0; i < 8; i++) s.write(ev());
    expect(await metricValue(metrics, 'mcp_call_events_dropped_total', 'buffer_full')).toBe(3);
    await s.flush();
    expect(batches[0]).toHaveLength(5);
  });

  it('retries a failed flush once, then drops the batch', async () => {
    let attempts = 0;
    const s = make({
      writeBatch: async () => {
        attempts++;
        throw new Error('db down');
      },
    });
    s.write(ev());
    await s.flush();
    expect(attempts).toBe(2);
    expect(await metricValue(metrics, 'mcp_call_events_dropped_total', 'flush_error')).toBe(1);
  });

  it('close() flushes what is left and rejects later writes', async () => {
    const s = make();
    s.write(ev());
    await s.close();
    expect(batches.map((b) => b.length)).toEqual([1]);
    s.write(ev());
    expect(await metricValue(metrics, 'mcp_call_events_dropped_total', 'closed')).toBe(1);
  });

  it('close() gives up after its time budget', async () => {
    const s = make({ writeBatch: () => new Promise(() => undefined), closeBudgetMs: 50 });
    s.write(ev());
    const closing = s.close();
    await vi.advanceTimersByTimeAsync(60);
    await expect(closing).resolves.toBeUndefined();
  });
});

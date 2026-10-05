import { describe, expect, it } from 'vitest';
import {
  argsHash,
  canonicalJson,
  descriptorTokens,
  estimateTokens,
  isUuidv7,
  overheadMs,
  spanName,
  toSpanAttributes,
  tokensSaved,
  uuidv7,
  uuidv7Time,
  type CallEvent,
} from './index';

describe('uuidv7', () => {
  it('embeds the timestamp and sorts by time', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(isUuidv7(a)).toBe(true);
    expect(uuidv7Time(a)?.getTime()).toBe(1_700_000_000_000);
    expect(a < b).toBe(true);
  });

  it('returns no time for other ids', () => {
    expect(uuidv7Time('3b241101-e2bb-4255-8caf-4136c566a962')).toBeUndefined();
  });

  it('is unique for the same millisecond', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7(1)));
    expect(ids.size).toBe(1000);
  });
});

describe('argsHash', () => {
  const key = new Uint8Array(32).fill(7);

  it('does not depend on key order', () => {
    expect(argsHash(key, { a: 1, b: { c: 2, d: [1, 2] } })).toBe(argsHash(key, { b: { d: [1, 2], c: 2 }, a: 1 }));
    expect(canonicalJson({ b: 1, a: undefined })).toBe('{"b":1}');
  });

  it('changes with the key and the values', () => {
    const other = new Uint8Array(32).fill(8);
    expect(argsHash(key, { a: 1 })).not.toBe(argsHash(other, { a: 1 }));
    expect(argsHash(key, { a: 1 })).not.toBe(argsHash(key, { a: 2 }));
  });
});

describe('tokens', () => {
  it('estimates bytes / 4', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(9)).toBe(3);
    expect(tokensSaved(4000, 1000)).toBe(750);
    expect(tokensSaved(10, 4000)).toBe(0);
    expect(descriptorTokens({ name: 'x' })).toBe(Math.ceil(JSON.stringify({ name: 'x' }).length / 4));
  });
});

describe('semconv', () => {
  const ev: CallEvent = {
    v: 1,
    ts: new Date(),
    callId: uuidv7(),
    tenantId: 't',
    tenantSlug: 'acme',
    kind: 'tool',
    endpoint: 'mcp',
    subject: 'agent',
    toolName: 'rh_colaborador_get',
    toolKind: 'openapi',
    decision: 'allow',
    latencyMs: 120,
    stages: { upstream: 100 },
    upstreamStatus: 200,
    tokensSavedProjection: 10,
    tokensSavedArtifact: 5,
  };

  it('maps GenAI/MCP attributes and keeps the legacy ones', () => {
    const a = toSpanAttributes(ev);
    expect(a).toMatchObject({
      'mcp.method.name': 'tools/call',
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'rh_colaborador_get',
      'gen_ai.tool.call.id': ev.callId,
      'mcp_gateway.tenant': 'acme',
      'mcp_gateway.overhead_ms': 20,
      'mcp_gateway.tokens.saved': 15,
      'http.response.status_code': 200,
      'mcp.tenant': 'acme',
      'mcp.tool': 'rh_colaborador_get',
      'mcp.decision': 'allow',
    });
    expect(spanName(ev)).toBe('tools/call rh_colaborador_get');
    expect(spanName({ kind: 'list', toolName: '*' })).toBe('tools/list');
    expect(overheadMs({ latencyMs: 5, stages: { upstream: 9 } })).toBe(0);
  });
});

describe('histogram', () => {
  it('buckets and estimates quantiles within one bucket', async () => {
    const { bucketIndex, histogramQuantile, mergeHistograms, LATENCY_BUCKETS_MS } = await import('./histogram');
    expect(bucketIndex(5)).toBe(0);
    expect(bucketIndex(6)).toBe(1);
    expect(bucketIndex(99_999)).toBe(LATENCY_BUCKETS_MS.length);
    const counts = new Array(LATENCY_BUCKETS_MS.length + 1).fill(0);
    for (const ms of [...Array(90).fill(20), ...Array(10).fill(400)]) counts[bucketIndex(ms)]++;
    const p50 = histogramQuantile(0.5, counts)!;
    const p95 = histogramQuantile(0.95, counts)!;
    expect(p50).toBeGreaterThan(10);
    expect(p50).toBeLessThanOrEqual(25);
    expect(p95).toBeGreaterThan(250);
    expect(p95).toBeLessThanOrEqual(500);
    expect(histogramQuantile(0.5, [])).toBeNull();
    expect(mergeHistograms([1, 2], [3])).toEqual([4, 2]);
  });
});

describe('anomaly and pricing', () => {
  it('flags a spike against the same hour of previous weeks', async () => {
    const { anomalyScores, priceTokens } = await import('./index');
    const HOUR = 3_600_000;
    const now = new Date('2026-10-04T12:30:00Z');
    const target = new Date('2026-10-04T11:00:00Z').getTime();
    const rows = [1, 2, 3, 4].flatMap((w) => [
      { key: 'bot-a', hour: new Date(target - w * 7 * 24 * HOUR), calls: 10 },
      { key: 'bot-b', hour: new Date(target - w * 7 * 24 * HOUR), calls: 50 },
    ]);
    rows.push({ key: 'bot-a', hour: new Date(target), calls: 200 }, { key: 'bot-b', hour: new Date(target), calls: 55 });
    const out = anomalyScores(rows, now);
    expect(out.map((a) => a.key)).toEqual(['bot-a']);
    expect(out[0]).toMatchObject({ calls: 200, baseline: 10 });
    expect(priceTokens(2_000_000, { currency: 'BRL', inputPerMTok: 15 })).toBe(30);
  });
});

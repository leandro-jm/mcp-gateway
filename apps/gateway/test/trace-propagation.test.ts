import { ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { extractInbound, injectOutbound } from '../src/telemetry/tracing';

const tp = (t: string, p: string) => `00-${t}-${p}-01`;
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

describe('trace propagation (F15.3)', () => {
  it('prefers _meta over the HTTP header', () => {
    const got = extractInbound({ meta: { traceparent: tp(A, '1'.repeat(16)) }, headers: { traceparent: tp(B, '2'.repeat(16)) } });
    expect(got?.source).toBe('meta');
    expect(trace.getSpanContext(got!.ctx)?.traceId).toBe(A);
    expect(got?.parentSpanId).toBe('1'.repeat(16));
  });

  it('falls back to the header (array values too) and ignores invalid values', () => {
    expect(extractInbound({ meta: { traceparent: 'garbage' }, headers: { traceparent: [tp(B, '2'.repeat(16))] } })?.source).toBe('header');
    expect(extractInbound({ meta: { traceparent: tp('0'.repeat(32), '1'.repeat(16)) } })).toBeUndefined();
    expect(extractInbound({ meta: 'x', headers: undefined })).toBeUndefined();
    expect(extractInbound({})).toBeUndefined();
  });

  it('injects only traceparent/tracestate, never baggage', () => {
    const ctx = trace.setSpanContext(ROOT_CONTEXT, { traceId: A, spanId: '3'.repeat(16), traceFlags: TraceFlags.SAMPLED, isRemote: false });
    expect(injectOutbound(ctx)).toEqual({ traceparent: tp(A, '3'.repeat(16)) });
    expect(injectOutbound(undefined)).toEqual({});
  });
});

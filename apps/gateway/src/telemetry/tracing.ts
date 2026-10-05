import {
  context,
  defaultTextMapSetter,
  isSpanContextValid,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type TextMapGetter,
  type Tracer,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export interface TracingHandle {
  tracer: Tracer;
  shutdown(): Promise<void>;
}

/**
 * OpenTelemetry traces (F9.2). With `OTEL_EXPORTER_OTLP_ENDPOINT`, exports via OTLP/HTTP;
 * without it, spans are created but not exported. Tests inject a span processor.
 */
export function createTracing(opts: { otlpEndpoint?: string; processors?: SpanProcessor[]; serviceName?: string } = {}): TracingHandle {
  const processors: SpanProcessor[] = [...(opts.processors ?? [])];
  if (opts.otlpEndpoint) {
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: `${opts.otlpEndpoint.replace(/\/$/, '')}/v1/traces` })));
  }
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: opts.serviceName ?? 'mcp-gateway' }),
    spanProcessors: processors,
  });
  return { tracer: provider.getTracer('mcp-gateway'), shutdown: () => provider.shutdown() };
}

// W3C trace context only (ADR-016 §8): `baggage` is never read, since it may carry PII.
const propagator = new W3CTraceContextPropagator();

type Carrier = Record<string, unknown>;
const getter: TextMapGetter<Carrier> = {
  keys: (c) => Object.keys(c),
  get: (c, key) => {
    const v = c[key] ?? c[key.toLowerCase()];
    if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
    return typeof v === 'string' ? v : undefined;
  },
};

export type InboundTraceSource = 'meta' | 'header';

export interface InboundTrace {
  ctx: Context;
  source: InboundTraceSource;
  /** Span id of the remote parent (the agent's span). */
  parentSpanId: string;
}

function extractFrom(carrier: unknown): Context | undefined {
  if (!carrier || typeof carrier !== 'object' || typeof getter.get(carrier as Carrier, 'traceparent') !== 'string') return undefined;
  const ctx = propagator.extract(ROOT_CONTEXT, carrier as Carrier, getter);
  const sc = trace.getSpanContext(ctx);
  return sc && isSpanContextValid(sc) ? ctx : undefined;
}

/**
 * Inbound trace context. Precedence: MCP `params._meta` (as the OTel MCP conventions recommend),
 * then the HTTP `traceparent` header. Invalid values are ignored (the call starts a new trace).
 */
export function extractInbound(sources: { meta?: unknown; headers?: unknown }): InboundTrace | undefined {
  for (const [source, carrier] of [
    ['meta', sources.meta],
    ['header', sources.headers],
  ] as const) {
    const ctx = extractFrom(carrier);
    if (ctx) return { ctx, source, parentSpanId: trace.getSpanContext(ctx)!.spanId };
  }
  return undefined;
}

/** `traceparent`/`tracestate` headers for an outbound request made inside `ctx`. */
export function injectOutbound(ctx: Context | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!ctx) return headers;
  propagator.inject(ctx, headers, defaultTextMapSetter);
  return headers;
}

/** Runs `fn` inside a child span of `parent` (explicit context, no global context manager). */
export async function inSpan<T>(
  tracer: Tracer,
  name: string,
  parent: Context | undefined,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span, ctx: Context) => Promise<T>,
): Promise<T> {
  const span = tracer.startSpan(name, { attributes }, parent ?? context.active());
  const ctx = trace.setSpan(parent ?? context.active(), span);
  try {
    return await fn(span, ctx);
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
    throw err;
  } finally {
    span.end();
  }
}

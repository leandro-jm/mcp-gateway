import { readObservabilitySettings } from '@mcp-gateway/core';
import type { CallContext } from '../proxy/executor';
import type { RegistrySnapshot } from '../registry/snapshot';
import { extractInbound } from '../telemetry/tracing';

function inboundEnabled(snapshot: RegistrySnapshot): boolean {
  return readObservabilitySettings(snapshot.tenant.settings).tracePropagation.inbound;
}

/** HTTP `traceparent` header (ADR-016 §8, second in precedence). */
export function withHeaderTrace(ctx: CallContext, headers: unknown): CallContext {
  if (!inboundEnabled(ctx.snapshot)) return ctx;
  const t = extractInbound({ headers });
  return t ? { ...ctx, traceCtx: t.ctx, inboundTrace: { source: t.source, parentSpanId: t.parentSpanId } } : ctx;
}

/** MCP `params._meta.traceparent`: wins over the HTTP header. */
export function withMetaTrace(ctx: CallContext, meta: unknown): CallContext {
  if (!inboundEnabled(ctx.snapshot)) return ctx;
  const t = extractInbound({ meta });
  return t ? { ...ctx, traceCtx: t.ctx, inboundTrace: { source: t.source, parentSpanId: t.parentSpanId } } : ctx;
}

/** Context of one MCP request (`tools/call`, `tools/list`): inbound trace from `_meta` and the JSON-RPC id. */
export function forRequest(ctx: CallContext, meta: unknown, requestId: unknown, signal?: AbortSignal): CallContext {
  const withTrace = withMetaTrace(signal ? { ...ctx, signal } : ctx, meta);
  if (requestId === undefined || requestId === null || !withTrace.identity) return withTrace;
  return { ...withTrace, identity: { ...withTrace.identity, jsonrpcId: String(requestId).slice(0, 64) } };
}

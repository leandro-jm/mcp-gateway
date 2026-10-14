import { readObservabilitySettings } from '@mcp-gateway/core';
import type { ServerContext } from '@modelcontextprotocol/server';
import type { CallContext, McpClientInfo } from '../proxy/executor';
import type { RegistrySnapshot } from '../registry/snapshot';
import { extractInbound } from '../telemetry/tracing';
import { uiRequestOf } from '../proxy/ui';

/** Reserved `_meta` envelope keys of the 2026-07-28 revision (ADR-021). */
export const ENVELOPE_KEYS = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
} as const;

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

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v ? v.slice(0, max) : undefined);

/**
 * Client declared in a 2026-07-28 request envelope. Self-declared and untrusted: values are
 * truncated and only used for analytics and capability negotiation, never for authorization.
 */
export function clientFromEnvelope(envelope: unknown): McpClientInfo | undefined {
  if (!envelope || typeof envelope !== 'object') return undefined;
  const e = envelope as Record<string, unknown>;
  const protocolVersion = str(e[ENVELOPE_KEYS.protocolVersion], 32);
  if (!protocolVersion) return undefined;
  const info = (e[ENVELOPE_KEYS.clientInfo] ?? {}) as Record<string, unknown>;
  const caps = (e[ENVELOPE_KEYS.clientCapabilities] ?? {}) as Record<string, unknown>;
  const ext = caps.extensions && typeof caps.extensions === 'object' ? Object.keys(caps.extensions).slice(0, 32) : [];
  const name = str(info.name, 128);
  const version = str(info.version, 64);
  return {
    era: 'modern',
    protocolVersion,
    ...(name ? { name } : {}),
    ...(version ? { version } : {}),
    extensions: ext.map((k) => k.slice(0, 128)),
  };
}

/** What is known about a client on a 2025-era stateless request: the protocol version header only. */
export function legacyClient(protocolVersion?: string): McpClientInfo {
  return { era: 'legacy', ...(protocolVersion ? { protocolVersion: protocolVersion.slice(0, 32) } : {}), extensions: [] };
}

export interface RequestInfo {
  /** `params._meta` as seen by the handler (reserved envelope keys already lifted out on 2026-07-28). */
  meta?: unknown;
  /** The 2026-07-28 `_meta` envelope, when the request carried one. */
  envelope?: unknown;
  requestId?: unknown;
  signal?: AbortSignal;
}

/** Request info of an SDK handler context; `tools/list` passes `signal: false` (nothing to cancel). */
export function requestInfo(h: ServerContext, withSignal = true): RequestInfo {
  return { meta: h.mcpReq._meta, envelope: h.mcpReq.envelope, requestId: h.mcpReq.id, ...(withSignal ? { signal: h.mcpReq.signal } : {}) };
}

/**
 * Context of one MCP request (`tools/call`, `tools/list`): inbound trace from `_meta`, the
 * JSON-RPC id and, on the 2026-07-28 era, the client declared in the envelope (ADR-021).
 */
export function forRequest(ctx: CallContext, req: RequestInfo): CallContext {
  const ui = uiRequestOf(req.meta);
  const withTrace = withMetaTrace({ ...ctx, ...(req.signal ? { signal: req.signal } : {}), ...(ui ? { ui } : {}) }, req.meta);
  const client = clientFromEnvelope(req.envelope);
  const withClient = client ? withModernClient(withTrace, client) : withTrace;
  const { requestId } = req;
  if (requestId === undefined || requestId === null || !withClient.identity) return withClient;
  return { ...withClient, identity: { ...withClient.identity, jsonrpcId: String(requestId).slice(0, 64) } };
}

/** A 2026-07-28 client: its envelope fills the analytics identity when no session header named the agent. */
function withModernClient(ctx: CallContext, client: McpClientInfo): CallContext {
  const identity = ctx.identity
    ? {
        ...ctx.identity,
        protocolVersion: client.protocolVersion,
        ...(ctx.identity.agentName || !client.name ? {} : { agentName: client.name }),
        ...(ctx.identity.agentVersion || !client.version ? {} : { agentVersion: client.version }),
      }
    : undefined;
  return { ...ctx, client, ...(identity ? { identity } : {}) };
}

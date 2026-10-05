import type { NetworkPolicy } from '@mcp-gateway/core';
import type { SnapshotSource, SnapshotTool } from '../registry/snapshot';

/** HTTP request built from a tool call. */
export interface HttpRequestSpec {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
}

export interface UpstreamCall {
  tenantId: string;
  tool: SnapshotTool;
  source: SnapshotSource;
  args: Record<string, unknown>;
  maxResponseBytes: number;
  /** Tenant outbound network policy (SSRF). */
  network: NetworkPolicy;
  signal?: AbortSignal;
  /** W3C trace context for the upstream (`traceparent`/`tracestate`), when propagation is on. */
  traceHeaders?: Record<string, string>;
}

export interface UpstreamResult {
  status: number;
  contentType: string | undefined;
  /** Parsed JSON when the content-type is JSON; otherwise, text. */
  body: unknown;
  bytes: number;
  durationMs: number;
  attempts: number;
}

/**
 * Extension point (PLAN §8): REST today; gRPC and MCP federation later.
 */
export interface UpstreamAdapter {
  readonly kind: string;
  call(call: UpstreamCall): Promise<UpstreamResult>;
}

export interface SourceHttpSettings {
  timeoutMs: number;
  maxRetries: number;
}

export function sourceHttpSettings(source: SnapshotSource): SourceHttpSettings {
  const s = source.settings as { timeoutMs?: unknown; maxRetries?: unknown };
  const n = (v: unknown, def: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : def;
  return { timeoutMs: n(s.timeoutMs, 10_000, 120_000), maxRetries: n(s.maxRetries, 2, 5) };
}

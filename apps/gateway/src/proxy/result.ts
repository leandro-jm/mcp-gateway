import { DEFAULT_LOCALE, type Locale } from '@mcp-gateway/i18n';
import { msg, translate } from '@mcp-gateway/i18n/server';
import type { SnapshotTool } from '../registry/snapshot';
import type { UpstreamResult } from './types';

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string } | Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const MAX_ERROR_MESSAGE = 500;

export function upstreamMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body.trim() || undefined;
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    for (const k of ['message', 'error_description', 'detail', 'title', 'error']) {
      if (typeof b[k] === 'string' && b[k]) return b[k] as string;
    }
  }
  return undefined;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Upstream text an agent may see in an error, as in a simple call: only for 4xx, from the
 * already redacted body, truncated. A 5xx body is never shown (stack traces, internal data).
 */
export function agentUpstreamMessage(status: number, redactedBody: unknown): string | undefined {
  if (status >= 500) return undefined;
  const m = upstreamMessage(redactedBody);
  return m === undefined ? undefined : truncate(m, MAX_ERROR_MESSAGE);
}

/** Tool error: JSON text only (no `structuredContent`, which the client would validate against the output schema). */
export function errorResult(payload: Record<string, unknown>): ToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/** Reads the JSON payload of an error result. */
export function errorPayload(r: unknown): Record<string, unknown> {
  const first = ((r as { content?: Array<{ text?: string }> }).content ?? [])[0];
  try {
    return JSON.parse(first?.text ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Structured shape of the response: arrays/scalars wrapped in `{ items }`/`{ value }` according to the mapping. */
export function structuredBody(tool: SnapshotTool, body: unknown): unknown {
  const wrap = tool.operationRef?.mapping?.response?.wrap;
  return wrap && typeof body !== 'string' ? { [wrap]: body } : body;
}

export interface UpstreamResultOptions {
  /** Locale of the gateway-authored texts (upstream messages are passed through untranslated). */
  locale?: Locale;
  /**
   * Receives the structured (post-redaction) shape of 2xx JSON responses; this is where
   * projection (F6) and artifact offload (F8) plug in.
   */
  transform?: (structured: unknown) => unknown;
}

/**
 * Converts the upstream response into the MCP result.
 * - 2xx → JSON as text + `structuredContent` (when there is an output schema);
 * - 4xx → tool error with the upstream message (useful to the agent, no stack);
 * - 5xx → tool error with the HTTP status.
 */
export function upstreamToToolResult(tool: SnapshotTool, res: UpstreamResult, opts: UpstreamResultOptions = {}): ToolResult {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const transform = opts.transform ?? ((v: unknown) => v);
  if (res.status >= 200 && res.status < 300) {
    if (res.body === '' || res.body === undefined || res.status === 204) {
      return { content: [{ type: 'text', text: translate(msg('proxy.noContent', { status: res.status }), locale) }] };
    }
    if (typeof res.body === 'string') return { content: [{ type: 'text', text: res.body }] };
    const structured = transform(structuredBody(tool, res.body));
    const result: ToolResult = { content: [{ type: 'text', text: JSON.stringify(structured) }] };
    if (tool.outputSchema && structured && typeof structured === 'object' && !Array.isArray(structured)) {
      result.structuredContent = structured as Record<string, unknown>;
    }
    return result;
  }
  const upstream = upstreamMessage(res.body);
  if (res.status >= 400 && res.status < 500) {
    const hint =
      res.status === 404
        ? msg('proxy.hintNotFound')
        : res.status === 400 || res.status === 422
          ? msg('proxy.hintRejected')
          : res.status === 401 || res.status === 403
            ? msg('proxy.hintUpstreamForbidden')
            : undefined;
    return errorResult({
      error: 'UPSTREAM_CLIENT_ERROR',
      status: res.status,
      message: truncate(upstream ?? translate(msg('proxy.upstreamResponded', { status: res.status }), locale), MAX_ERROR_MESSAGE),
      ...(hint ? { hint: translate(hint, locale) } : {}),
    });
  }
  return errorResult({
    error: 'UPSTREAM_ERROR',
    status: res.status,
    message: translate(msg('proxy.upstreamServerError', { status: res.status }), locale),
  });
}

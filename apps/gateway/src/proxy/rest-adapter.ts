import { UpstreamError, type NetworkPolicy } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import { BodyTooLarge, OutboundBlocked, outboundFetch, readLimited } from '@mcp-gateway/net';
import type { CredentialManager } from './credentials';
import { buildHttpRequest } from './request-builder';
import { sourceHttpSettings, type HttpRequestSpec, type UpstreamAdapter, type UpstreamCall, type UpstreamResult } from './types';

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);
const RETRYABLE_STATUS = new Set([502, 503, 504]);

export class ResponseTooLarge extends UpstreamError {
  constructor(limit: number) {
    super(msg('proxy.responseTooLarge', { limit }), undefined, { limit });
  }
}

export class UpstreamTimeout extends UpstreamError {
  constructor(timeoutMs: number) {
    super(msg('proxy.timeout', { timeoutMs }), undefined, { timeoutMs });
  }
}

/** Network failure (connection refused, DNS, reset). Counts as a source failure in the circuit breaker. */
export class NetworkError extends UpstreamError {}

async function readBody(res: Response, limit: number): Promise<{ text: string; bytes: number }> {
  try {
    return await readLimited(res, limit);
  } catch (err) {
    if (err instanceof BodyTooLarge) throw new ResponseTooLarge(limit);
    throw err;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Values the credential added to the request (headers and query): they must never reach the agent. */
function appliedSecrets(before: { headers: Record<string, string>; query: URLSearchParams }, req: HttpRequestSpec): string[] {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(req.headers)) {
    if (before.headers[k] === v) continue;
    out.add(v);
    const scheme = /^(?:Bearer|Basic)\s+(.+)$/i.exec(v);
    if (scheme) out.add(scheme[1]!);
  }
  for (const [k, v] of req.url.searchParams) if (!before.query.getAll(k).includes(v)) out.add(v);
  return [...out].filter((s) => s.length >= 8); // short values would scrub ordinary text
}

/** Upstreams echo the API key in pagination links, debug fields and errors: scrub it from the body. */
function scrubSecrets(text: string, secrets: string[]): string {
  for (const s of secrets) {
    for (const form of new Set([s, encodeURIComponent(s)])) if (text.includes(form)) text = text.split(form).join('[credential]');
  }
  return text;
}

/** The gateway's trace headers replace any same-named header that came from the arguments. */
function applyTraceHeaders(req: HttpRequestSpec, trace: Record<string, string>): void {
  const names = new Set(Object.keys(trace).map((k) => k.toLowerCase()));
  for (const k of Object.keys(req.headers)) if (names.has(k.toLowerCase())) delete req.headers[k];
  Object.assign(req.headers, trace);
}

/** MCP → REST translator. Changes nothing in the downstream service. */
export class RestAdapter implements UpstreamAdapter {
  readonly kind = 'rest';

  constructor(private readonly credentials: CredentialManager) {}

  async call(call: UpstreamCall): Promise<UpstreamResult> {
    const op = call.tool.operationRef;
    if (!op) throw new UpstreamError(msg('proxy.noUpstreamOperation', { tool: call.tool.name }));
    const { timeoutMs, maxRetries } = sourceHttpSettings(call.source);
    const retries = IDEMPOTENT.has(op.method.toUpperCase()) ? maxRetries : 0;
    const started = Date.now();
    let attempts = 0;
    let renewedToken = false;

    for (;;) {
      attempts += 1;
      const req = buildHttpRequest(call.source.baseUrl, op, call.args);
      if (call.traceHeaders) applyTraceHeaders(req, call.traceHeaders);
      const before = { headers: { ...req.headers }, query: new URLSearchParams(req.url.searchParams) };
      const oauthToken = call.source.credentialId
        ? await this.credentials.apply(call.tenantId, call.source.credentialId, req, call.network)
        : null;
      const secrets = appliedSecrets(before, req);
      let res: Response;
      try {
        res = await this.send(req, timeoutMs, call.network, call.signal);
      } catch (err) {
        if (attempts <= retries && err instanceof NetworkError) {
          await sleep(backoff(attempts));
          continue;
        }
        throw err;
      }

      // Token expired/revoked on the upstream: renew it once, transparently.
      if (res.status === 401 && oauthToken && !renewedToken) {
        await res.body?.cancel();
        renewedToken = true;
        await this.credentials.invalidateToken(call.tenantId, call.source.credentialId!, oauthToken);
        attempts -= 1;
        continue;
      }
      if (RETRYABLE_STATUS.has(res.status) && attempts <= retries) {
        await res.body?.cancel();
        await sleep(backoff(attempts));
        continue;
      }

      const { text: rawText, bytes } = await readBody(res, call.maxResponseBytes);
      const text = scrubSecrets(rawText, secrets);
      const contentType = res.headers.get('content-type') ?? undefined;
      let body: unknown = text;
      if (text && contentType && /json/i.test(contentType)) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      return { status: res.status, contentType, body, bytes, durationMs: Date.now() - started, attempts };
    }
  }

  private async send(req: HttpRequestSpec, timeoutMs: number, network: NetworkPolicy, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await outboundFetch(req.url, {
        method: req.method,
        headers: req.headers,
        ...(req.body !== undefined ? { body: req.body } : {}),
        redirect: 'manual',
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      }, network);
    } catch (err) {
      if (err instanceof OutboundBlocked) throw new UpstreamError(msg('proxy.outboundBlocked', { reason: err.msg }), undefined, { code: 'SSRF_BLOCKED' });
      if (timeout.aborted) throw new UpstreamTimeout(timeoutMs);
      // Does not expose the internal host/IP to the agent: only the error code.
      const code = ((err as Error).cause as { code?: string } | undefined)?.code ?? 'NETWORK_ERROR';
      throw new NetworkError(msg('proxy.networkError'), undefined, { code });
    }
  }
}

function backoff(attempt: number): number {
  return Math.min(100 * 2 ** (attempt - 1), 2000) + Math.floor(Math.random() * 50);
}

import { UpstreamError, ValidationError, type GatewayError, type NetworkPolicy } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import { BodyTooLarge, OutboundBlocked, outboundFetch, readLimited } from '@mcp-gateway/net';
import { DecisionWireError } from '@mcp-gateway/tool-router';

/** Hard ceiling of one provider call; the router passes a shorter per-point timeout. */
export const DECISION_CALL_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

/** Maps an HTTP status of the provider to a gateway error; the provider body is never echoed (it may quote the key). */
export function decisionHttpError(status: number): GatewayError {
  if (status === 401 || status === 403) return new ValidationError(msg('router.invalidKey'), { providerStatus: status });
  if (status === 429) return new UpstreamError(msg('router.providerRateLimited'), status);
  return new UpstreamError(msg('router.providerError', { error: `HTTP ${status}` }), status);
}

const isAbort = (err: unknown) => err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');

/** Errors that are not HTTP statuses: blocked destination, timeout/abort, network. */
export function decisionTransportError(err: unknown): GatewayError {
  if (err instanceof OutboundBlocked) return new ValidationError(err.msg);
  if (isAbort(err)) return new UpstreamError(msg('router.timeout'));
  return new UpstreamError(msg('router.providerError', { error: err instanceof Error ? err.name : 'network error' }));
}

export function invalidResponse(): GatewayError {
  return new UpstreamError(msg('router.invalidResponse'));
}

/**
 * POSTs a decision request through the outbound guard: a custom base URL cannot reach private
 * addresses (SSRF, DNS rebinding) and a redirect cannot carry the key to another host.
 */
export async function postDecision(url: string, body: unknown, apiKey: string, network: NetworkPolicy, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(DECISION_CALL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await outboundFetch(
      url,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      },
      network,
    );
  } catch (err) {
    throw decisionTransportError(err);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw decisionHttpError(res.status);
  }
  try {
    return JSON.parse((await readLimited(res, MAX_RESPONSE_BYTES)).text);
  } catch (err) {
    if (err instanceof BodyTooLarge || err instanceof SyntaxError) throw invalidResponse();
    throw decisionTransportError(err);
  }
}

/** Parses with the wire mapping; a shape mismatch becomes `router.invalidResponse`. */
export function parseWire<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    if (err instanceof DecisionWireError) throw invalidResponse();
    throw err;
  }
}

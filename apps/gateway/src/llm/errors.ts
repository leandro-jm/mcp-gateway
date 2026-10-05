import { UpstreamError, ValidationError, type GatewayError } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import { OutboundBlocked } from '@mcp-gateway/net';

/** Maps an HTTP status of the provider to a gateway error; the provider body is never echoed (it may quote the key). */
export function llmHttpError(status: number): GatewayError {
  if (status === 401 || status === 403) return new ValidationError(msg('llm.invalidKey'), { providerStatus: status });
  if (status === 429) return new UpstreamError(msg('llm.providerRateLimited'), status);
  return new UpstreamError(msg('llm.providerError', { error: `HTTP ${status}` }), status);
}

export function llmTimeoutError(): GatewayError {
  return new UpstreamError(msg('llm.timeout'));
}

const isAbort = (err: unknown) => err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');

/** Errors that are not HTTP statuses: blocked destination, timeout/abort, network. */
export function llmTransportError(err: unknown): GatewayError {
  if (err instanceof OutboundBlocked) return new ValidationError(err.msg);
  if (isAbort(err)) return llmTimeoutError();
  return new UpstreamError(msg('llm.providerError', { error: err instanceof Error ? err.name : 'network error' }));
}

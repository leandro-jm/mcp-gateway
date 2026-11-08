import { OAuthProtocolError } from './errors';

/** Query string or form body as parsed by the HTTP layer (repeated keys become arrays). */
export type OAuthParams = Record<string, unknown>;

const MAX_PARAM_LENGTH = 4096;

/**
 * Reads one parameter. Empty values count as absent (RFC 6749 §3.1); a repeated parameter or a
 * non-string value is `invalid_request`.
 */
export function single(params: OAuthParams, name: string): string | undefined {
  const value = params[name];
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) throw new OAuthProtocolError('invalid_request', 'duplicate_parameter', name);
  if (typeof value !== 'string' || value.length > MAX_PARAM_LENGTH) {
    throw new OAuthProtocolError('invalid_request', 'invalid_parameter', name);
  }
  return value === '' ? undefined : value;
}

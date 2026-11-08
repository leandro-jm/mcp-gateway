import { OAuthProtocolError } from './errors';

/** Access to the MCP data plane with the authorizing user's permissions. */
export const SCOPE_MCP = 'mcp';
/** Issues a refresh token. */
export const SCOPE_OFFLINE_ACCESS = 'offline_access';
export const SUPPORTED_SCOPES: readonly string[] = [SCOPE_MCP, SCOPE_OFFLINE_ACCESS];

/** RFC 6749 §3.3 `scope-token`. */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
const MAX_SCOPES = 20;

/** Parses a space-delimited `scope` parameter into unique tokens. Absent or empty gives `[]`. */
export function parseScope(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  const tokens = raw.split(' ').filter((token) => token.length > 0);
  if (tokens.length > MAX_SCOPES || tokens.some((token) => !SCOPE_TOKEN.test(token))) {
    throw new OAuthProtocolError('invalid_scope', 'invalid_scope', 'scope');
  }
  return [...new Set(tokens)];
}

/**
 * Scopes granted for a request: unknown ones are dropped (ADR-030) and `mcp`, the only resource
 * scope, is always included.
 */
export function grantableScopes(requested: readonly string[]): string[] {
  const granted = new Set([SCOPE_MCP]);
  for (const scope of requested) if (SUPPORTED_SCOPES.includes(scope)) granted.add(scope);
  return SUPPORTED_SCOPES.filter((scope) => granted.has(scope));
}

export function formatScope(scopes: readonly string[]): string {
  return scopes.join(' ');
}

export function coversScopes(granted: readonly string[], requested: readonly string[]): boolean {
  return requested.every((scope) => granted.includes(scope));
}

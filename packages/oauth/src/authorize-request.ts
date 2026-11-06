/**
 * Authorization request parsing in two stages (RFC 6749 §4.1.2.1). Stage one identifies the client
 * and the redirect; until the redirect is validated against the client, errors must be shown to
 * the user and never redirected (no open redirect). Stage two runs after that, and its errors are
 * sent back to the client on the redirect.
 */
import { OAuthProtocolError } from './errors';
import { single, type OAuthParams } from './params';
import { isValidCodeChallenge } from './pkce';
import { canonicalMcpResource, defaultMcpResource } from './resource';
import { grantableScopes, parseScope } from './scopes';

const MAX_STATE_LENGTH = 1024;

export interface AuthorizationTarget {
  clientId: string;
  redirectUri: string;
}

export interface AuthorizationRequest extends AuthorizationTarget {
  state?: string;
  codeChallenge: string;
  resource: string;
  scopes: string[];
}

/** Stage one. Errors here are rendered as a page. */
export function parseAuthorizationTarget(params: OAuthParams): AuthorizationTarget {
  const clientId = single(params, 'client_id');
  if (!clientId) throw new OAuthProtocolError('invalid_request', 'missing_client_id', 'client_id');
  const redirectUri = single(params, 'redirect_uri');
  if (!redirectUri) throw new OAuthProtocolError('invalid_request', 'missing_redirect_uri', 'redirect_uri');
  return { clientId, redirectUri };
}

/** The `state` to echo on an error redirect, or `undefined` when it is absent or unusable. */
export function readState(params: OAuthParams): string | undefined {
  const value = params.state;
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_STATE_LENGTH ? value : undefined;
}

/** Stage two, after `target.redirectUri` matched the client. Errors here go to the redirect. */
export function parseAuthorizationRequest(
  params: OAuthParams,
  target: AuthorizationTarget,
  publicUrl: string,
): AuthorizationRequest {
  const state = single(params, 'state');
  if (state !== undefined && state.length > MAX_STATE_LENGTH) {
    throw new OAuthProtocolError('invalid_request', 'invalid_state', 'state');
  }
  if (single(params, 'response_type') !== 'code') {
    throw new OAuthProtocolError('unsupported_response_type', 'unsupported_response_type', 'response_type');
  }
  const codeChallenge = single(params, 'code_challenge');
  if (!codeChallenge) throw new OAuthProtocolError('invalid_request', 'missing_code_challenge', 'code_challenge');
  if (!isValidCodeChallenge(codeChallenge)) {
    throw new OAuthProtocolError('invalid_request', 'invalid_code_challenge', 'code_challenge');
  }
  if (single(params, 'code_challenge_method') !== 'S256') {
    throw new OAuthProtocolError('invalid_request', 'unsupported_challenge_method', 'code_challenge_method');
  }
  return {
    ...target,
    state,
    codeChallenge,
    resource: resourceParam(params, publicUrl) ?? defaultMcpResource(publicUrl),
    scopes: grantableScopes(parseScope(single(params, 'scope'))),
  };
}

/** Optional `resource` parameter in canonical form; a value that is not an MCP surface here is `invalid_target`. */
export function resourceParam(params: OAuthParams, publicUrl: string): string | undefined {
  const raw = single(params, 'resource');
  if (raw === undefined) return undefined;
  const resource = canonicalMcpResource(raw, publicUrl);
  if (!resource) throw new OAuthProtocolError('invalid_target', 'invalid_resource', 'resource');
  return resource;
}

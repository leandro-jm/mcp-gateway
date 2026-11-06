/** Token endpoint request parsing (RFC 6749 §4.1.3 and §6) for public clients. */
import { resourceParam } from './authorize-request';
import { OAuthProtocolError, type OAuthErrorReason } from './errors';
import { single, type OAuthParams } from './params';
import { isValidCodeVerifier } from './pkce';
import { parseScope } from './scopes';

export type TokenRequest =
  | {
      grantType: 'authorization_code';
      clientId: string;
      code: string;
      redirectUri: string;
      codeVerifier: string;
      resource?: string;
    }
  | {
      grantType: 'refresh_token';
      clientId: string;
      refreshToken: string;
      /** Requested narrowing; absent keeps the grant's scopes. */
      scopes?: string[];
      resource?: string;
    };

function required(params: OAuthParams, name: string, reason: OAuthErrorReason): string {
  const value = single(params, name);
  if (!value) throw new OAuthProtocolError('invalid_request', reason, name);
  return value;
}

export function parseTokenRequest(params: OAuthParams, publicUrl: string): TokenRequest {
  const grantType = single(params, 'grant_type');
  if (!grantType) throw new OAuthProtocolError('invalid_request', 'missing_grant_type', 'grant_type');
  if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
    throw new OAuthProtocolError('unsupported_grant_type', 'unsupported_grant_type', 'grant_type');
  }
  const clientId = required(params, 'client_id', 'missing_client_id');
  const resource = resourceParam(params, publicUrl);

  if (grantType === 'authorization_code') {
    const code = required(params, 'code', 'missing_code');
    const redirectUri = required(params, 'redirect_uri', 'missing_redirect_uri');
    const codeVerifier = required(params, 'code_verifier', 'missing_code_verifier');
    if (!isValidCodeVerifier(codeVerifier)) {
      throw new OAuthProtocolError('invalid_request', 'invalid_code_verifier', 'code_verifier');
    }
    return { grantType, clientId, code, redirectUri, codeVerifier, resource };
  }

  const refreshToken = required(params, 'refresh_token', 'missing_refresh_token');
  const scope = single(params, 'scope');
  return { grantType, clientId, refreshToken, scopes: scope === undefined ? undefined : parseScope(scope), resource };
}

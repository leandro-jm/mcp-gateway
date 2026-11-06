import { describe, expect, it } from 'vitest';
import { parseAuthorizationRequest, parseAuthorizationTarget, readState } from './authorize-request';
import { OAuthProtocolError, oauthErrorBody, oauthErrorStatus } from './errors';
import { authorizationServerMetadata } from './metadata';
import { parseTokenRequest } from './token-request';

const PUBLIC_URL = 'https://mcp.example.com';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof OAuthProtocolError) return `${err.code}/${err.reason}`;
    throw err;
  }
  return undefined;
}

describe('authorization request', () => {
  const target = { clientId: 'https://claude.ai/meta', redirectUri: 'https://claude.ai/cb' };
  const params = {
    client_id: target.clientId,
    redirect_uri: target.redirectUri,
    response_type: 'code',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    resource: `${PUBLIC_URL}/mcp/omni`,
    scope: 'mcp offline_access',
    state: 'xyz',
  };

  it('identifies the client and redirect first', () => {
    expect(parseAuthorizationTarget(params)).toEqual(target);
    expect(reasonOf(() => parseAuthorizationTarget({ redirect_uri: 'x' }))).toBe('invalid_request/missing_client_id');
    expect(reasonOf(() => parseAuthorizationTarget({ client_id: 'x', redirect_uri: '' }))).toBe(
      'invalid_request/missing_redirect_uri',
    );
    expect(reasonOf(() => parseAuthorizationTarget({ client_id: ['a', 'b'], redirect_uri: 'x' }))).toBe(
      'invalid_request/duplicate_parameter',
    );
  });

  it('parses a complete request', () => {
    expect(parseAuthorizationRequest(params, target, PUBLIC_URL)).toEqual({
      ...target,
      state: 'xyz',
      codeChallenge: CHALLENGE,
      resource: `${PUBLIC_URL}/mcp/omni`,
      scopes: ['mcp', 'offline_access'],
    });
  });

  it('defaults the resource and scope for older clients', () => {
    const { resource: _r, scope: _s, ...rest } = params;
    const req = parseAuthorizationRequest(rest, target, PUBLIC_URL);
    expect(req.resource).toBe(`${PUBLIC_URL}/mcp`);
    expect(req.scopes).toEqual(['mcp']);
  });

  it('requires code flow with S256 PKCE', () => {
    expect(reasonOf(() => parseAuthorizationRequest({ ...params, response_type: 'token' }, target, PUBLIC_URL))).toBe(
      'unsupported_response_type/unsupported_response_type',
    );
    expect(reasonOf(() => parseAuthorizationRequest({ ...params, code_challenge: undefined }, target, PUBLIC_URL))).toBe(
      'invalid_request/missing_code_challenge',
    );
    expect(reasonOf(() => parseAuthorizationRequest({ ...params, code_challenge: 'short' }, target, PUBLIC_URL))).toBe(
      'invalid_request/invalid_code_challenge',
    );
    expect(reasonOf(() => parseAuthorizationRequest({ ...params, code_challenge_method: 'plain' }, target, PUBLIC_URL))).toBe(
      'invalid_request/unsupported_challenge_method',
    );
    expect(
      reasonOf(() => parseAuthorizationRequest({ ...params, code_challenge_method: undefined }, target, PUBLIC_URL)),
    ).toBe('invalid_request/unsupported_challenge_method');
  });

  it('rejects resources of other servers', () => {
    expect(
      reasonOf(() => parseAuthorizationRequest({ ...params, resource: 'https://evil.example.com/mcp' }, target, PUBLIC_URL)),
    ).toBe('invalid_target/invalid_resource');
  });

  it('reads the state for error redirects without throwing', () => {
    expect(readState(params)).toBe('xyz');
    expect(readState({ state: ['a', 'b'] })).toBeUndefined();
    expect(readState({ state: 'x'.repeat(2000) })).toBeUndefined();
    expect(reasonOf(() => parseAuthorizationRequest({ ...params, state: 'x'.repeat(2000) }, target, PUBLIC_URL))).toBe(
      'invalid_request/invalid_state',
    );
  });
});

describe('token request', () => {
  const code = {
    grant_type: 'authorization_code',
    client_id: 'https://claude.ai/meta',
    code: 'abc',
    redirect_uri: 'https://claude.ai/cb',
    code_verifier: VERIFIER,
    resource: `${PUBLIC_URL}/mcp`,
  };

  it('parses an authorization_code grant', () => {
    expect(parseTokenRequest(code, PUBLIC_URL)).toEqual({
      grantType: 'authorization_code',
      clientId: code.client_id,
      code: 'abc',
      redirectUri: code.redirect_uri,
      codeVerifier: VERIFIER,
      resource: `${PUBLIC_URL}/mcp`,
    });
  });

  it('parses a refresh_token grant with optional narrowing', () => {
    const base = { grant_type: 'refresh_token', client_id: 'c', refresh_token: 'mgr_x' };
    expect(parseTokenRequest(base, PUBLIC_URL)).toEqual({
      grantType: 'refresh_token',
      clientId: 'c',
      refreshToken: 'mgr_x',
      scopes: undefined,
      resource: undefined,
    });
    expect(parseTokenRequest({ ...base, scope: 'mcp' }, PUBLIC_URL)).toMatchObject({ scopes: ['mcp'] });
  });

  it('rejects incomplete or unsupported requests', () => {
    expect(reasonOf(() => parseTokenRequest({}, PUBLIC_URL))).toBe('invalid_request/missing_grant_type');
    expect(reasonOf(() => parseTokenRequest({ grant_type: 'client_credentials' }, PUBLIC_URL))).toBe(
      'unsupported_grant_type/unsupported_grant_type',
    );
    expect(reasonOf(() => parseTokenRequest({ ...code, client_id: undefined }, PUBLIC_URL))).toBe(
      'invalid_request/missing_client_id',
    );
    expect(reasonOf(() => parseTokenRequest({ ...code, code_verifier: undefined }, PUBLIC_URL))).toBe(
      'invalid_request/missing_code_verifier',
    );
    expect(reasonOf(() => parseTokenRequest({ ...code, code_verifier: 'x' }, PUBLIC_URL))).toBe(
      'invalid_request/invalid_code_verifier',
    );
    expect(reasonOf(() => parseTokenRequest({ ...code, resource: 'https://evil.example.com/mcp' }, PUBLIC_URL))).toBe(
      'invalid_target/invalid_resource',
    );
    expect(reasonOf(() => parseTokenRequest({ ...code, code: ['a', 'b'] }, PUBLIC_URL))).toBe(
      'invalid_request/duplicate_parameter',
    );
  });
});

describe('errors and metadata', () => {
  it('maps error codes to HTTP status and body', () => {
    expect(oauthErrorStatus('invalid_client')).toBe(401);
    expect(oauthErrorStatus('invalid_grant')).toBe(400);
    expect(oauthErrorStatus('server_error')).toBe(500);
    expect(oauthErrorBody('invalid_grant', 'Code expired')).toEqual({ error: 'invalid_grant', error_description: 'Code expired' });
    expect(oauthErrorBody('invalid_grant')).toEqual({ error: 'invalid_grant' });
    expect(new OAuthProtocolError('invalid_request', 'missing_code', 'code').message).toBe('invalid_request: missing_code (code)');
  });

  it('builds the RFC 8414 document', () => {
    const meta = authorizationServerMetadata({ publicUrl: `${PUBLIC_URL}/`, registration: true });
    expect(meta).toMatchObject({
      issuer: PUBLIC_URL,
      authorization_endpoint: `${PUBLIC_URL}/oauth/authorize`,
      token_endpoint: `${PUBLIC_URL}/oauth/token`,
      registration_endpoint: `${PUBLIC_URL}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    expect(authorizationServerMetadata({ publicUrl: PUBLIC_URL, registration: false })).not.toHaveProperty(
      'registration_endpoint',
    );
  });
});

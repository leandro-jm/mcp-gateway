/**
 * OAuth error model (RFC 6749 §4.1.2.1 and §5.2, RFC 7591 §3.2.2, RFC 8707 §2). The `reason` is a
 * stable machine key: the gateway turns it into a localized `error_description` (i18n area `oauth`)
 * and logs it as-is, so it never carries request values.
 */

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'access_denied'
  | 'unsupported_response_type'
  | 'server_error'
  | 'temporarily_unavailable'
  | 'invalid_target'
  | 'invalid_redirect_uri'
  | 'invalid_client_metadata';

/** Every reason, so the gateway can check that each one has a localized description. */
export const OAUTH_ERROR_REASONS = [
  // request parsing (this package)
  'duplicate_parameter',
  'invalid_parameter',
  'missing_client_id',
  'invalid_client_id',
  'missing_redirect_uri',
  'invalid_redirect_uri',
  'redirect_uri_mismatch',
  'unsupported_response_type',
  'missing_code_challenge',
  'invalid_code_challenge',
  'unsupported_challenge_method',
  'invalid_resource',
  'invalid_state',
  'invalid_scope',
  'missing_grant_type',
  'unsupported_grant_type',
  'missing_code',
  'missing_code_verifier',
  'invalid_code_verifier',
  'missing_refresh_token',
  'invalid_client_metadata',
  'client_id_mismatch',
  'unsupported_auth_method',
  'unsupported_grant_types',
  // decisions taken by the gateway (clients, tenant, grants)
  'client_unavailable',
  'client_disabled',
  'client_not_allowed',
  'tenant_oauth_disabled',
  'user_not_allowed',
  'user_denied',
  'request_expired',
  'invalid_code',
  'code_reused',
  'pkce_mismatch',
  'resource_mismatch',
  'client_mismatch',
  'invalid_refresh_token',
  'refresh_token_reused',
  'registration_disabled',
  'rate_limited',
  'internal_error',
] as const;

export type OAuthErrorReason = (typeof OAUTH_ERROR_REASONS)[number];

export class OAuthProtocolError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    readonly reason: OAuthErrorReason,
    /** Name of the offending parameter, when there is one (never its value). */
    readonly param?: string,
  ) {
    super(param ? `${code}: ${reason} (${param})` : `${code}: ${reason}`);
    this.name = 'OAuthProtocolError';
  }

  get status(): number {
    return oauthErrorStatus(this.code);
  }
}

/** HTTP status for an error returned by the token, registration or revocation endpoint. */
export function oauthErrorStatus(code: OAuthErrorCode): number {
  switch (code) {
    case 'invalid_client':
      return 401;
    case 'server_error':
      return 500;
    case 'temporarily_unavailable':
      return 503;
    default:
      return 400;
  }
}

export interface OAuthErrorBody {
  error: OAuthErrorCode;
  error_description?: string;
}

export function oauthErrorBody(code: OAuthErrorCode, description?: string): OAuthErrorBody {
  return description ? { error: code, error_description: description } : { error: code };
}

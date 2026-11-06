/** Authorization Server Metadata (RFC 8414) served by the gateway. */
import { issuerOf } from './resource';
import { SUPPORTED_SCOPES } from './scopes';

export const OAUTH_PATHS = {
  authorize: '/oauth/authorize',
  token: '/oauth/token',
  revoke: '/oauth/revoke',
  register: '/oauth/register',
} as const;

export interface AuthorizationServerMetadataOptions {
  publicUrl: string;
  /** Advertise the DCR endpoint (`OAUTH_DCR_ENABLED`). */
  registration: boolean;
  serviceDocumentation?: string;
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  registration_endpoint?: string;
  scopes_supported: string[];
  response_types_supported: string[];
  response_modes_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  revocation_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
  client_id_metadata_document_supported: boolean;
  authorization_response_iss_parameter_supported: boolean;
  service_documentation?: string;
}

export function authorizationServerMetadata(opts: AuthorizationServerMetadataOptions): AuthorizationServerMetadata {
  const issuer = issuerOf(opts.publicUrl);
  return {
    issuer,
    authorization_endpoint: `${issuer}${OAUTH_PATHS.authorize}`,
    token_endpoint: `${issuer}${OAUTH_PATHS.token}`,
    revocation_endpoint: `${issuer}${OAUTH_PATHS.revoke}`,
    ...(opts.registration ? { registration_endpoint: `${issuer}${OAUTH_PATHS.register}` } : {}),
    scopes_supported: [...SUPPORTED_SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    ...(opts.serviceDocumentation ? { service_documentation: opts.serviceDocumentation } : {}),
  };
}

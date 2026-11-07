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

/** Protected Resource Metadata (RFC 9728) of the gateway or of one of its MCP surfaces. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_name: string;
  resource_documentation?: string;
}

export function protectedResourceMetadata(opts: {
  publicUrl: string;
  resource: string;
  resourceName?: string;
  documentation?: string;
}): ProtectedResourceMetadata {
  return {
    resource: opts.resource,
    authorization_servers: [issuerOf(opts.publicUrl)],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: opts.resourceName ?? 'MCP Gateway',
    ...(opts.documentation ? { resource_documentation: opts.documentation } : {}),
  };
}

/** Path of the metadata document of a resource (RFC 9728 §3.1): the well-known prefix plus the resource path. */
export function protectedResourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  const path = url.pathname === '/' ? '' : url.pathname;
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

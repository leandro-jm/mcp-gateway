/**
 * Dynamic Client Registration (RFC 7591), kept for clients that do not speak CIMD yet (deprecated
 * in MCP spec 2026-07-28). Only public clients are registered: an `auth_method` other than `none`
 * is replaced by `none` in the response (RFC 7591 §3.2.1 lets the server override metadata), which
 * keeps clients that default to `client_secret_post` working.
 */
import { z } from 'zod';
import { cleanClientName } from './client-metadata';
import { OAuthProtocolError } from './errors';
import { inferApplicationType, isAcceptableRedirectUri, type ApplicationType } from './redirect';

const MAX_REDIRECT_URIS = 10;
export const SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;
export type GrantType = (typeof SUPPORTED_GRANT_TYPES)[number];

export interface RegistrationRequest {
  clientName?: string;
  clientUri?: string;
  redirectUris: string[];
  applicationType: ApplicationType;
  grantTypes: GrantType[];
}

const requestSchema = z.object({
  client_name: z.string().max(1000).optional(),
  client_uri: z.string().max(2048).optional(),
  redirect_uris: z.array(z.string()).min(1).max(MAX_REDIRECT_URIS),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).max(10).optional(),
  response_types: z.array(z.string()).max(10).optional(),
  application_type: z.string().optional(),
});

/** Validates a registration request body. Errors use the RFC 7591 codes. */
export function parseRegistrationRequest(body: unknown): RegistrationRequest {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    const redirectIssue = parsed.error.issues.some((issue) => issue.path[0] === 'redirect_uris');
    throw redirectIssue
      ? new OAuthProtocolError('invalid_redirect_uri', 'invalid_redirect_uri', 'redirect_uris')
      : new OAuthProtocolError('invalid_client_metadata', 'invalid_client_metadata');
  }
  const req = parsed.data;
  if (req.application_type !== undefined && req.application_type !== 'web' && req.application_type !== 'native') {
    throw new OAuthProtocolError('invalid_client_metadata', 'invalid_client_metadata', 'application_type');
  }
  const grantTypes = req.grant_types ?? ['authorization_code', 'refresh_token'];
  if (!grantTypes.includes('authorization_code')) {
    throw new OAuthProtocolError('invalid_client_metadata', 'unsupported_grant_types', 'grant_types');
  }
  if (req.response_types !== undefined && !req.response_types.includes('code')) {
    throw new OAuthProtocolError('invalid_client_metadata', 'unsupported_response_type', 'response_types');
  }
  const redirectUris = [...new Set(req.redirect_uris)];
  const applicationType = (req.application_type as ApplicationType | undefined) ?? inferApplicationType(redirectUris);
  if (!redirectUris.every((uri) => isAcceptableRedirectUri(uri, applicationType))) {
    throw new OAuthProtocolError('invalid_redirect_uri', 'invalid_redirect_uri', 'redirect_uris');
  }
  let clientUri: string | undefined;
  if (req.client_uri !== undefined) {
    try {
      clientUri = new URL(req.client_uri).protocol === 'https:' ? req.client_uri : undefined;
    } catch {
      clientUri = undefined;
    }
  }
  return {
    clientName: cleanClientName(req.client_name),
    clientUri,
    redirectUris,
    applicationType,
    grantTypes: SUPPORTED_GRANT_TYPES.filter((type) => grantTypes.includes(type)),
  };
}

/** RFC 7591 §3.2.1 response for a registered public client. */
export function registrationResponse(clientId: string, issuedAt: Date, req: RegistrationRequest) {
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(issuedAt.getTime() / 1000),
    ...(req.clientName ? { client_name: req.clientName } : {}),
    ...(req.clientUri ? { client_uri: req.clientUri } : {}),
    redirect_uris: req.redirectUris,
    application_type: req.applicationType,
    grant_types: req.grantTypes,
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

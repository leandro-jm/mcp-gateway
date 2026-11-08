/**
 * Client ID Metadata Documents (CIMD), the main registration mechanism of MCP spec 2026-07-28: the
 * `client_id` is an HTTPS URL that serves the client's metadata. The gateway fetches it; this
 * module only decides whether a `client_id` can be one and whether a fetched document is valid.
 */
import { z } from 'zod';
import { OAuthProtocolError } from './errors';
import { inferApplicationType, isAcceptableRedirectUri, type ApplicationType } from './redirect';

export const MAX_CLIENT_METADATA_BYTES = 5 * 1024;
const MAX_CLIENT_ID_LENGTH = 2048;
const MAX_CLIENT_NAME_LENGTH = 200;
const MAX_REDIRECT_URIS = 20;

/** Metadata the gateway keeps for a client, whatever the registration mechanism. */
export interface ClientMetadata {
  clientId: string;
  kind: 'cimd' | 'dcr';
  clientName: string;
  redirectUris: string[];
  applicationType: ApplicationType;
  clientUri?: string;
}

/**
 * Whether a `client_id` is a metadata document URL: HTTPS, with a path, without credentials,
 * query or fragment, and already in canonical form (so `/a/../b` or `HTTPS://X` never alias another
 * client).
 */
export function isClientMetadataUrl(clientId: string): boolean {
  if (clientId.length > MAX_CLIENT_ID_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.href === clientId &&
    url.pathname.length > 1 &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}

/** Host shown on the consent screen and used in `Principal.clientId` (`oauth:<host>`). */
export function clientMetadataHost(clientId: string): string {
  return new URL(clientId).host;
}

/** Removes control characters and surrounding blanks from a self-declared display name. */
export function cleanClientName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  return cleaned.length > 0 ? cleaned.slice(0, MAX_CLIENT_NAME_LENGTH) : undefined;
}

function httpsUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw).protocol === 'https:' ? raw : undefined;
  } catch {
    return undefined;
  }
}

const documentSchema = z.object({
  client_id: z.string(),
  client_name: z.string().optional(),
  client_uri: z.string().optional(),
  redirect_uris: z.array(z.string()).min(1).max(MAX_REDIRECT_URIS),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  application_type: z.enum(['web', 'native']).optional(),
});

/** Validates a fetched metadata document for `clientId`. Errors are `invalid_client`. */
export function parseClientMetadataDocument(json: unknown, clientId: string): ClientMetadata {
  const parsed = documentSchema.safeParse(json);
  if (!parsed.success) throw new OAuthProtocolError('invalid_client', 'invalid_client_metadata');
  const doc = parsed.data;
  if (doc.client_id !== clientId) throw new OAuthProtocolError('invalid_client', 'client_id_mismatch');
  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== 'none') {
    throw new OAuthProtocolError('invalid_client', 'unsupported_auth_method');
  }
  if (doc.grant_types !== undefined && !doc.grant_types.includes('authorization_code')) {
    throw new OAuthProtocolError('invalid_client', 'unsupported_grant_types');
  }
  if (doc.response_types !== undefined && !doc.response_types.includes('code')) {
    throw new OAuthProtocolError('invalid_client', 'unsupported_response_type');
  }
  const applicationType = doc.application_type ?? inferApplicationType(doc.redirect_uris);
  if (!doc.redirect_uris.every((uri) => isAcceptableRedirectUri(uri, applicationType))) {
    throw new OAuthProtocolError('invalid_client', 'invalid_redirect_uri');
  }
  return {
    clientId,
    kind: 'cimd',
    clientName: cleanClientName(doc.client_name) ?? clientMetadataHost(clientId),
    redirectUris: [...new Set(doc.redirect_uris)],
    applicationType,
    clientUri: httpsUrl(doc.client_uri),
  };
}

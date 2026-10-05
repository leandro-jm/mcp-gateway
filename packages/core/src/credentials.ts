import { z } from 'zod';

/** Plaintext configuration of each credential type. Only exists in memory in the gateway. */
export const credentialConfigSchemas = {
  oauth2_client_credentials: z.object({
    tokenUrl: z.url(),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    scope: z.string().optional(),
    audience: z.string().optional(),
    /** Where to send client_id/secret: in the body (default) or via HTTP Basic. */
    authMethod: z.enum(['body', 'basic']).default('body'),
  }),
  oauth2_password: z.object({
    tokenUrl: z.url(),
    clientId: z.string().min(1),
    clientSecret: z.string().optional(),
    username: z.string().min(1),
    password: z.string().min(1),
    scope: z.string().optional(),
    authMethod: z.enum(['body', 'basic']).default('body'),
  }),
  api_key: z.object({
    in: z.enum(['header', 'query']).default('header'),
    name: z.string().min(1),
    value: z.string().min(1),
  }),
  bearer_static: z.object({ token: z.string().min(1) }),
  basic: z.object({ username: z.string().min(1), password: z.string().min(1) }),
} as const;

export type CredentialType = keyof typeof credentialConfigSchemas;
export type CredentialConfig<T extends CredentialType = CredentialType> = z.output<(typeof credentialConfigSchemas)[T]>;

export const CREDENTIAL_TYPES = Object.keys(credentialConfigSchemas) as CredentialType[];

export const credentialInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('oauth2_client_credentials'), config: credentialConfigSchemas.oauth2_client_credentials }),
  z.object({ type: z.literal('oauth2_password'), config: credentialConfigSchemas.oauth2_password }),
  z.object({ type: z.literal('api_key'), config: credentialConfigSchemas.api_key }),
  z.object({ type: z.literal('bearer_static'), config: credentialConfigSchemas.bearer_static }),
  z.object({ type: z.literal('basic'), config: credentialConfigSchemas.basic }),
]);

export type CredentialInput = z.output<typeof credentialInputSchema>;

/** Non-secret fields of each type; the rest never leaves the gateway. */
const PUBLIC_FIELDS: Record<CredentialType, string[]> = {
  oauth2_client_credentials: ['tokenUrl', 'clientId', 'scope', 'audience', 'authMethod'],
  oauth2_password: ['tokenUrl', 'clientId', 'username', 'scope', 'authMethod'],
  api_key: ['in', 'name'],
  bearer_static: [],
  basic: ['username'],
};

/** Public view (without secrets) of a credential's configuration. */
export function describeCredentialConfig(type: CredentialType, config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(PUBLIC_FIELDS[type].filter((k) => config[k] !== undefined).map((k) => [k, config[k]]));
}

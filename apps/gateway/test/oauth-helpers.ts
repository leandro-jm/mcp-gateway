import { generateApiToken } from '@mcp-gateway/core';
import type { Harness } from './harness';

/** Turns OAuth on or off for a tenant (`settings.oauth`) and drops the caches that read it. */
export async function setTenantOAuth(h: Harness, slug: string, oauth: Record<string, unknown>): Promise<void> {
  const tenant = await h.services.repos.tenants.findBySlug(slug);
  if (!tenant) throw new Error(`tenant ${slug} not found`);
  await h.services.repos.tenants.update(tenant.id, { settings: { ...tenant.settings, oauth } });
  await h.services.registry.invalidate(tenant.id);
  h.services.verifier.clear();
}

export interface MintedOAuthToken {
  token: string;
  grantId: string;
  clientRowId: string;
}

/**
 * Issues an OAuth access token the way the token endpoint will (F20.7): a client, the user's
 * grant and an `oauth` token tied to it. The user is created by `h.token` with role `agent`.
 */
export async function mintOAuthToken(
  h: Harness,
  opts: {
    sub: string;
    tenant: string;
    clientId?: string;
    kind?: 'cimd' | 'dcr';
    scopes?: string[];
    roles?: string[];
  },
): Promise<MintedOAuthToken> {
  const { repos } = h.services;
  await h.token({ sub: opts.sub, tenant: opts.tenant, roles: opts.roles ?? ['agent'] });
  const user = await repos.auth.findUser(opts.sub);
  if (!user?.tenantId) throw new Error(`user ${opts.sub} not created`);
  const kind = opts.kind ?? 'cimd';
  const clientId = opts.clientId ?? (kind === 'cimd' ? 'https://claude.ai/oauth/mcp-client-metadata' : 'dcr_test-client');
  const input = { clientId, clientName: 'Test client', redirectUris: ['http://127.0.0.1/callback'], applicationType: 'native' as const };
  const client = kind === 'cimd' ? await repos.oauth.upsertCimdClient(input) : ((await repos.oauth.findClient(clientId)) ?? (await repos.oauth.createDcrClient(input)));
  const grant = await repos.oauth.saveGrant({
    tenantId: user.tenantId,
    userId: user.id,
    clientId: client.id,
    scopes: opts.scopes ?? ['mcp'],
    resource: 'http://gateway.test/mcp',
  });
  const t = generateApiToken();
  await repos.auth.createToken(user.id, {
    name: 'oauth',
    kind: 'oauth',
    tokenHash: t.hash,
    prefix: t.prefix,
    expiresAt: new Date(Date.now() + 3_600_000),
    grantId: grant.id,
  });
  return { token: t.token, grantId: grant.id, clientRowId: client.id };
}

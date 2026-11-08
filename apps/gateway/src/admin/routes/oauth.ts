import { Forbidden, readOAuthSettings, Unauthorized, ValidationError } from '@mcp-gateway/core';
import type { OAuthClientView, OAuthGrantView } from '@mcp-gateway/db';
import { msg } from '@mcp-gateway/i18n/server';
import { isAllowlistHost, isClientMetadataUrl, issuerOf } from '@mcp-gateway/oauth';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { oauthClientId } from '../../auth/tokens';
import type { Services } from '../../services';
import { isPlatformAdmin, requirePrincipal, resolveTenantId, ROLE } from '../auth';
import {
  errorResponses,
  noContent,
  oauthClientPatchSchema,
  oauthClientQuery,
  oauthClientSchema,
  oauthGrantQuery,
  oauthGrantSchema,
  oauthSettingsBody,
  oauthSettingsViewSchema,
  page,
  uuidParam,
} from '../schemas';

const iso = (d: Date) => d.toISOString();
const isoN = (d: Date | null) => (d ? d.toISOString() : null);

const grantDto = (g: OAuthGrantView) => ({
  ...g,
  policyClientId: oauthClientId({ clientId: g.clientId, clientKind: g.clientKind }),
  createdAt: iso(g.createdAt),
  lastUsedAt: isoN(g.lastUsedAt),
});

const clientDto = (c: OAuthClientView) => ({
  id: c.id,
  clientId: c.clientId,
  kind: c.kind,
  clientName: c.clientName,
  clientUri: c.clientUri,
  redirectUris: c.redirectUris,
  applicationType: c.applicationType,
  policyClientId: oauthClientId({ clientId: c.clientId, clientKind: c.kind }),
  activeGrants: c.activeGrants,
  fetchedAt: isoN(c.fetchedAt),
  lastUsedAt: isoN(c.lastUsedAt),
  disabledAt: isoN(c.disabledAt),
  createdAt: iso(c.createdAt),
});

/** A host, a CIMD URL or a DCR client id (see `clientInAllowlist`). */
const validAllowlistEntry = (entry: string) =>
  isAllowlistHost(entry.toLowerCase()) || isClientMetadataUrl(entry) || /^dcr_[A-Za-z0-9_-]{8,64}$/.test(entry);

/**
 * OAuth for MCP clients in the Admin API (ADR-030): the tenant switch and allowlist, the grants
 * ("Connected apps") for admins and for each user, and the platform-wide client list.
 */
export const oauthAdminRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const { config, repos, verifier } = services;
  const tags = ['oauth'];
  const admin = { roles: [ROLE.admin] };

  async function settingsView(tenantId: string) {
    const tenant = await repos.tenants.get(tenantId);
    const s = readOAuthSettings(tenant.settings);
    return {
      platformEnabled: config.OAUTH_ENABLED,
      dcrEnabled: config.OAUTH_DCR_ENABLED,
      issuer: issuerOf(config.PUBLIC_URL),
      platformAccessTtlMinutes: config.OAUTH_ACCESS_TTL_MINUTES,
      platformRefreshTtlDays: config.OAUTH_REFRESH_TTL_DAYS,
      settings: {
        enabled: s.enabled,
        clients: s.clients,
        allowlist: s.allowlist,
        accessTtlMinutes: s.accessTtlMinutes ?? null,
        refreshTtlDays: s.refreshTtlDays ?? null,
      },
    };
  }

  app.get('/settings/oauth', {
    config: admin,
    schema: { tags, summary: 'App connections (OAuth) of the tenant', response: { 200: oauthSettingsViewSchema, ...errorResponses } },
    handler: async (req) => settingsView(await resolveTenantId(services, req)),
  });

  app.put('/settings/oauth', {
    config: admin,
    schema: { tags, summary: 'Turns app connections on or off and edits the allowlist', body: oauthSettingsBody, response: { 200: oauthSettingsViewSchema, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const body = req.body;
      const invalid = body.allowlist.find((entry) => !validAllowlistEntry(entry));
      if (invalid) throw new ValidationError(msg('oauth.invalidAllowlistEntry', { entry: invalid }));
      const oauth = {
        enabled: body.enabled,
        clients: body.clients,
        allowlist: [...new Set(body.allowlist)],
        ...(body.accessTtlMinutes ? { accessTtlMinutes: body.accessTtlMinutes } : {}),
        ...(body.refreshTtlDays ? { refreshTtlDays: body.refreshTtlDays } : {}),
      };
      const tenant = await repos.tenants.get(tenantId);
      await repos.tenants.update(tenantId, { settings: { ...tenant.settings, oauth } });
      // tokens of apps that lost access stop on this replica now, on the others within the cache TTL
      verifier.clear();
      await repos.audit.record(tenantId, {
        action: 'settings.oauth.update',
        subject: requirePrincipal(req).sub,
        decision: 'applied',
        details: { enabled: oauth.enabled, clients: oauth.clients, allowlist: oauth.allowlist.length },
      });
      return settingsView(tenantId);
    },
  });

  app.get('/oauth/grants', {
    config: admin,
    schema: { tags, summary: "Connected apps of the tenant's users", querystring: oauthGrantQuery, response: { 200: page(oauthGrantSchema), ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const { items, total } = await repos.oauthGrants.list(tenantId, req.query);
      return { items: items.map(grantDto), total };
    },
  });

  app.delete('/oauth/grants/:id', {
    config: admin,
    schema: { tags, summary: 'Revokes a connected app of a user (and its tokens)', params: uuidParam, response: { ...noContent, ...errorResponses } },
    handler: async (req, reply) => {
      const tenantId = await resolveTenantId(services, req);
      verifier.forget(...(await repos.oauthGrants.revoke(tenantId, req.params.id)));
      await repos.audit.record(tenantId, { action: 'oauth.grant.revoke', subject: requirePrincipal(req).sub, decision: 'applied', details: { grantId: req.params.id } });
      return reply.code(204).send(null);
    },
  });

  /** The signed-in user and its tenant; connected apps exist only for tenant users. */
  async function self(req: Parameters<typeof requirePrincipal>[0]) {
    const p = requirePrincipal(req);
    if (!p.userId || !p.tenant) throw new Unauthorized();
    const tenant = await repos.tenants.findBySlug(p.tenant);
    if (!tenant) throw new Unauthorized();
    return { tenantId: tenant.id, userId: p.userId, sub: p.sub };
  }

  app.get('/me/oauth/grants', {
    schema: { tags, summary: 'Apps connected to the signed-in user', querystring: oauthGrantQuery.omit({ userId: true }), response: { 200: page(oauthGrantSchema), ...errorResponses } },
    handler: async (req) => {
      const { tenantId, userId } = await self(req);
      const { items, total } = await repos.oauthGrants.list(tenantId, { ...req.query, userId });
      return { items: items.map(grantDto), total };
    },
  });

  app.delete('/me/oauth/grants/:id', {
    schema: { tags, summary: 'Disconnects one of my apps (and revokes its tokens)', params: uuidParam, response: { ...noContent, ...errorResponses } },
    handler: async (req, reply) => {
      const { tenantId, userId, sub } = await self(req);
      verifier.forget(...(await repos.oauthGrants.revoke(tenantId, req.params.id, { userId })));
      await repos.audit.record(tenantId, { action: 'oauth.grant.revoke', subject: sub, decision: 'applied', details: { grantId: req.params.id, self: true } });
      return reply.code(204).send(null);
    },
  });

  const platformOnly = (req: Parameters<typeof requirePrincipal>[0]) => {
    if (!isPlatformAdmin(requirePrincipal(req))) throw new Forbidden(msg('auth.platformAdminOnly'));
  };

  app.get('/platform/oauth/clients', {
    config: admin,
    schema: { tags, summary: 'Apps known to the authorization server (all tenants)', querystring: oauthClientQuery, response: { 200: page(oauthClientSchema), ...errorResponses } },
    handler: async (req) => {
      platformOnly(req);
      const { items, total } = await repos.oauth.listClients(req.query);
      return { items: items.map(clientDto), total };
    },
  });

  app.patch('/platform/oauth/clients/:id', {
    config: admin,
    schema: { tags, summary: 'Disables or re-enables an app on the whole gateway', params: uuidParam, body: oauthClientPatchSchema, response: { 200: oauthClientSchema, ...errorResponses } },
    handler: async (req) => {
      platformOnly(req);
      const { client, revoked } = await repos.oauth.setClientDisabled(req.params.id, req.body.disabled);
      verifier.forget(...revoked);
      await repos.audit.record(null, {
        action: req.body.disabled ? 'oauth.client.disable' : 'oauth.client.enable',
        subject: requirePrincipal(req).sub,
        clientId: oauthClientId({ clientId: client.clientId, clientKind: client.kind }),
        decision: 'applied',
        details: { revokedTokens: revoked.length },
      });
      return clientDto(await repos.oauth.getClientView(client.id));
    },
  });
};

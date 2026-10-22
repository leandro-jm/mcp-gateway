import { assertOutboundUrl, GatewayError, OutboundBlocked, readToolRouterSettings, toolRouterSettingsSchema, ValidationError } from '@mcp-gateway/core';
import type { DecisionSettingsView } from '@mcp-gateway/db';
import { msg, translate } from '@mcp-gateway/i18n/server';
import { DEFAULT_DECISION_MODELS } from '@mcp-gateway/tool-router';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { z } from 'zod';
import { requestLocale } from '../../i18n';
import { llmNetworkPolicy } from '../../llm/tenant';
import type { Services } from '../../services';
import { requirePrincipal, resolveTenantId, ROLE } from '../auth';
import {
  decisionProviderPutSchema,
  decisionProviderSchema,
  decisionProviderTestSchema,
  errorResponses,
  llmTestResultSchema,
  noContent,
  toolRouterSettingsBody,
  toolRouterViewSchema,
} from '../schemas';

/** Error code the Admin UI uses to point to the provider card. */
export const ROUTER_NOT_CONFIGURED = 'ROUTER_NOT_CONFIGURED';

function providerDto(v: DecisionSettingsView | null): z.input<typeof decisionProviderSchema> {
  return v ? { configured: true, ...v, updatedAt: v.updatedAt.toISOString() } : { configured: false };
}

/**
 * Decision-model tool router (ADR-025). Behavior lives in `tenants.settings.toolRouter` (snapshot,
 * no secrets); the provider and its write-only key live in `tenant_decision_settings`.
 */
export const toolRouterRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const repo = services.repos.decisionSettings;
  const tags = ['settings'];
  const admin = { roles: [ROLE.admin] };

  async function view(tenantId: string): Promise<z.input<typeof toolRouterViewSchema>> {
    const tenant = await services.repos.tenants.get(tenantId);
    return { platformEnabled: services.config.TOOL_ROUTER_ENABLED, settings: readToolRouterSettings(tenant.settings), provider: providerDto(await repo.get(tenantId)) };
  }

  /** A custom base URL is checked against the tenant network policy (SSRF), like the LLM provider's. */
  async function checkedBaseUrl(tenantId: string, baseUrl: string | null | undefined): Promise<string | null> {
    if (!baseUrl) return null;
    try {
      assertOutboundUrl(baseUrl, await llmNetworkPolicy(services, tenantId));
    } catch (err) {
      if (err instanceof OutboundBlocked) throw new ValidationError(err.msg);
      throw err;
    }
    return baseUrl;
  }

  app.get('/settings/tool-router', {
    config: admin,
    schema: { tags, summary: 'Tool router settings and decision provider (never returns the key)', response: { 200: toolRouterViewSchema, ...errorResponses } },
    handler: async (req) => view(await resolveTenantId(services, req)),
  });

  app.put('/settings/tool-router', {
    config: admin,
    schema: { tags, summary: 'Updates the tool router behavior (switches per point, thresholds, timeouts)', body: toolRouterSettingsBody, response: { 200: toolRouterViewSchema, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const parsed = toolRouterSettingsSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(msg('router.invalidSettings', { reason: parsed.error.issues[0]?.path.join('.') || parsed.error.issues[0]?.message || '' }));
      const s = parsed.data;
      if (s.enabled && !(await repo.get(tenantId))?.hasApiKey) {
        throw new ValidationError(msg('router.providerNotConfigured'), { code: ROUTER_NOT_CONFIGURED });
      }
      const tenant = await services.repos.tenants.get(tenantId);
      await services.repos.tenants.update(tenantId, { settings: { ...tenant.settings, toolRouter: s } });
      await services.repos.audit.record(tenantId, {
        action: 'settings.toolRouter.update',
        subject: requirePrincipal(req).sub,
        decision: 'applied',
        details: { enabled: s.enabled, rerank: s.rerank.enabled, shortlist: s.shortlist.enabled, gate: s.gate.enabled },
      });
      return view(tenantId);
    },
  });

  app.put('/settings/tool-router/provider', {
    config: admin,
    schema: { tags, summary: 'Configures the decision provider and its API key', body: decisionProviderPutSchema, response: { 200: decisionProviderSchema, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const principal = requirePrincipal(req);
      const current = await repo.get(tenantId);
      const baseUrl = await checkedBaseUrl(tenantId, req.body.baseUrl);
      // a key belongs to one provider: switching providers without a new key drops the old one
      const apiKey = req.body.apiKey === undefined && current && current.provider !== req.body.provider ? null : req.body.apiKey;
      const model = req.body.model ?? DEFAULT_DECISION_MODELS[req.body.provider];
      const saved = await repo.upsert(tenantId, { provider: req.body.provider, model, baseUrl, apiKey }, principal.sub);
      services.router?.forgetTenant(tenantId);
      await services.repos.audit.record(tenantId, {
        action: 'settings.toolRouter.provider.update',
        subject: principal.sub,
        clientId: principal.clientId,
        decision: 'applied',
        details: { provider: saved.provider, model: saved.model, key: apiKey === undefined ? 'kept' : apiKey === null ? 'removed' : 'replaced' },
      });
      return providerDto(saved);
    },
  });

  app.delete('/settings/tool-router/provider', {
    config: admin,
    schema: { tags, summary: 'Removes the decision provider; an enabled router falls back to the behavior without it', response: { ...noContent, ...errorResponses } },
    handler: async (req, reply) => {
      const tenantId = await resolveTenantId(services, req);
      const principal = requirePrincipal(req);
      await repo.delete(tenantId);
      services.router?.forgetTenant(tenantId);
      await services.repos.audit.record(tenantId, { action: 'settings.toolRouter.provider.delete', subject: principal.sub, clientId: principal.clientId, decision: 'applied' });
      return reply.code(204).send(null);
    },
  });

  app.post('/settings/tool-router/test', {
    config: admin,
    schema: {
      tags,
      summary: 'Runs one tiny decision with the provider (unsaved fields override the stored ones)',
      body: decisionProviderTestSchema,
      response: { 200: llmTestResultSchema, ...errorResponses },
    },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const stored = await repo.getDecrypted(tenantId);
      const provider = req.body.provider ?? stored?.provider;
      if (!provider) throw new ValidationError(msg('router.notConfigured'), { code: ROUTER_NOT_CONFIGURED });
      const model = req.body.model ?? (stored?.provider === provider ? stored.model : DEFAULT_DECISION_MODELS[provider]);
      const baseUrl = await checkedBaseUrl(tenantId, req.body.baseUrl !== undefined ? req.body.baseUrl : stored?.baseUrl);
      // the stored key is only reused for the same provider
      const apiKey = req.body.apiKey ?? (stored?.provider === provider ? stored.apiKey : null);
      if (!apiKey) throw new ValidationError(msg('router.noApiKey'), { code: ROUTER_NOT_CONFIGURED });
      const client = services.decisions({ provider, model, baseUrl, apiKey }, await llmNetworkPolicy(services, tenantId));
      const started = Date.now();
      try {
        await client.ping();
        return { ok: true, latencyMs: Date.now() - started };
      } catch (err) {
        if (!(err instanceof GatewayError)) throw err;
        return { ok: false, latencyMs: Date.now() - started, error: translate(err.msg, requestLocale(req)) };
      }
    },
  });
};

import { assertOutboundUrl, GatewayError, OutboundBlocked, ValidationError } from '@mcp-gateway/core';
import type { LlmSettingsView } from '@mcp-gateway/db';
import { msg, translate } from '@mcp-gateway/i18n/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { z } from 'zod';
import { LLM_NOT_CONFIGURED, llmNetworkPolicy } from '../../llm/tenant';
import { requestLocale } from '../../i18n';
import type { Services } from '../../services';
import { isAdmin, requirePrincipal, resolveTenantId, ROLE } from '../auth';
import { errorResponses, llmSettingsPutSchema, llmSettingsSchema, llmSettingsTestSchema, llmTestResultSchema, noContent } from '../schemas';

type LlmSettingsPut = z.output<typeof llmSettingsPutSchema>;

function llmDto(v: LlmSettingsView | null, full: boolean): z.input<typeof llmSettingsSchema> {
  if (!v) return { configured: false };
  // owners only need to know whether the composer is available
  if (!full) return { configured: true, provider: v.provider, model: v.model };
  return { configured: true, ...v, updatedAt: v.updatedAt.toISOString() };
}

/**
 * Tenant LLM configuration for the natural-language composer (ADR-015). The API key is
 * write-only: it is encrypted with the tenant data key and only its hint is ever returned.
 */
export const settingsRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const repo = services.repos.llmSettings;
  const tags = ['settings'];
  const admin = { roles: [ROLE.admin] };

  /** `base_url` only for compatible providers, checked against the tenant network policy (SSRF). */
  async function baseUrlFor(tenantId: string, body: Partial<LlmSettingsPut>): Promise<string | null> {
    if (body.provider !== 'openai_compatible') return null;
    if (!body.baseUrl) throw new ValidationError(msg('llm.baseUrlRequired'));
    try {
      assertOutboundUrl(body.baseUrl, await llmNetworkPolicy(services, tenantId));
    } catch (err) {
      if (err instanceof OutboundBlocked) throw new ValidationError(err.msg);
      throw err;
    }
    return body.baseUrl;
  }

  app.get('/settings/llm', {
    config: { roles: [ROLE.admin, ROLE.owner] },
    schema: { tags, summary: 'LLM provider of the composer (never returns the key)', response: { 200: llmSettingsSchema, ...errorResponses } },
    handler: async (req) => llmDto(await repo.get(await resolveTenantId(services, req)), isAdmin(requirePrincipal(req))),
  });

  app.put('/settings/llm', {
    config: admin,
    schema: { tags, summary: 'Configures the LLM provider and its API key', body: llmSettingsPutSchema, response: { 200: llmSettingsSchema, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const principal = requirePrincipal(req);
      const current = await repo.get(tenantId);
      const baseUrl = await baseUrlFor(tenantId, req.body);
      // a key belongs to one provider: switching providers without a new key drops the old one
      const apiKey = req.body.apiKey === undefined && current && current.provider !== req.body.provider ? null : req.body.apiKey;
      const saved = await repo.upsert(tenantId, { ...req.body, baseUrl, apiKey }, principal.sub);
      await services.repos.audit.record(tenantId, {
        action: 'settings.llm.update',
        subject: principal.sub,
        clientId: principal.clientId,
        decision: 'applied',
        details: { provider: saved.provider, model: saved.model, key: apiKey === undefined ? 'kept' : apiKey === null ? 'removed' : 'replaced' },
      });
      return llmDto(saved, true);
    },
  });

  app.delete('/settings/llm', {
    config: admin,
    schema: { tags, response: { ...noContent, ...errorResponses } },
    handler: async (req, reply) => {
      const tenantId = await resolveTenantId(services, req);
      const principal = requirePrincipal(req);
      await repo.delete(tenantId);
      await services.repos.audit.record(tenantId, { action: 'settings.llm.delete', subject: principal.sub, clientId: principal.clientId, decision: 'applied' });
      return reply.code(204).send(null);
    },
  });

  app.post('/settings/llm/test', {
    config: admin,
    schema: {
      tags,
      summary: 'Checks the key and the model without generating (unsaved fields override the stored ones)',
      body: llmSettingsTestSchema,
      response: { 200: llmTestResultSchema, ...errorResponses },
    },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const stored = await repo.getDecrypted(tenantId);
      const provider = req.body.provider ?? stored?.provider;
      const model = req.body.model ?? stored?.model;
      if (!provider || !model) throw new ValidationError(msg('llm.notConfigured'), { code: LLM_NOT_CONFIGURED });
      const draft = { ...req.body, provider, baseUrl: req.body.baseUrl ?? stored?.baseUrl ?? null };
      const baseUrl = await baseUrlFor(tenantId, draft);
      // the stored key is only reused for the same provider
      const apiKey = req.body.apiKey ?? (stored?.provider === provider ? stored.apiKey : null);
      if (!apiKey) throw new ValidationError(msg('llm.noApiKey'), { code: LLM_NOT_CONFIGURED });
      const client = services.llm(
        { provider, model, baseUrl, apiKey, jsonMode: req.body.jsonMode ?? stored?.jsonMode ?? 'schema' },
        await llmNetworkPolicy(services, tenantId),
      );
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

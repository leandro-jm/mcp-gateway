import { validateQuery } from '@mcp-gateway/call-analytics';
import { Forbidden, observabilitySettingsSchema, readObservabilitySettings, ValidationError } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { finopsView, rangeOf, securityView, sreView, toolsView } from '../../analytics/views';
import type { Services } from '../../services';
import { isAdmin, isPlatformAdmin, requirePrincipal, resolveTenantId, ROLE } from '../auth';
import { analyticsQueryBody, analyticsResultSchema, errorResponses, jsonObject, observabilitySettingsBody, viewQuery } from '../schemas';
import { canManageTool } from './tools';

/** Roles that read analytics (ADR-016, ADR-011 addendum). */
export const ANALYTICS_ROLES = [ROLE.admin, ROLE.analyticsReader];

export const analyticsRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const tags = ['analytics'];

  app.post('/analytics/query', {
    config: { roles: ANALYTICS_ROLES },
    schema: {
      tags,
      summary: 'Typed analytics query over the call rollups (no raw SQL)',
      body: analyticsQueryBody,
      response: { 200: analyticsResultSchema, ...errorResponses },
    },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const v = validateQuery(req.body);
      if (!v.ok) throw new ValidationError(v.error);
      return services.analytics.query(tenantId, v.query);
    },
  });

  app.get('/analytics/sre', {
    config: { roles: ANALYTICS_ROLES },
    schema: { tags, summary: 'SRE view: gateway overhead vs upstream, errors per source and stage, open circuits', querystring: viewQuery, response: { 200: jsonObject, ...errorResponses } },
    handler: async (req) => sreView(services, await resolveTenantId(services, req), rangeOf(req.query.last)),
  });

  app.get('/analytics/tools', {
    config: { roles: [...ANALYTICS_ROLES, ROLE.owner] },
    schema: { tags, summary: 'Tool owner view: usage per agent, errors, retries, never-used tools, drift impact', querystring: viewQuery, response: { 200: jsonObject, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const caller = requirePrincipal(req);
      // owners only see their own tools
      const scope = isAdmin(caller) || caller.roles.includes(ROLE.analyticsReader)
        ? {}
        : { toolNames: (await services.registry.get(tenantId)).tools.filter((t) => canManageTool(caller, t)).map((t) => t.name) };
      return toolsView(services, tenantId, rangeOf(req.query.last), scope);
    },
  });

  app.get('/analytics/security', {
    config: { roles: ANALYTICS_ROLES },
    schema: { tags, summary: 'Security view: denials, redactions per detector, volume anomalies', querystring: viewQuery, response: { 200: jsonObject, ...errorResponses } },
    handler: async (req) => securityView(services, await resolveTenantId(services, req), rangeOf(req.query.last)),
  });

  app.get('/analytics/finops', {
    config: { roles: ANALYTICS_ROLES },
    schema: { tags, summary: 'FinOps view: tokens saved by mechanism and in money, usage per client, agent and subject', querystring: viewQuery, response: { 200: jsonObject, ...errorResponses } },
    handler: async (req) => finopsView(services, await resolveTenantId(services, req), rangeOf(req.query.last)),
  });

  app.get('/platform/usage', {
    config: { roles: [ROLE.admin] },
    schema: { tags, summary: 'Usage of every tenant (platform admin only)', querystring: viewQuery, response: { 200: jsonObject, ...errorResponses } },
    handler: async (req) => {
      if (!isPlatformAdmin(requirePrincipal(req))) throw new Forbidden(msg('auth.crossTenantForbidden'));
      const r = rangeOf(req.query.last);
      return { from: r.from.toISOString(), to: r.to.toISOString(), tenants: await services.repos.platformUsage.byTenant(r.from, r.to) };
    },
  });

  app.get('/settings/observability', {
    config: { roles: ANALYTICS_ROLES },
    schema: { tags: ['settings'], summary: 'Observability settings of the tenant (trace propagation, session id, pricing, subject index, report_outcome)', response: { 200: jsonObject, ...errorResponses } },
    handler: async (req) => readObservabilitySettings((await services.repos.tenants.get(await resolveTenantId(services, req))).settings),
  });

  app.put('/settings/observability', {
    config: { roles: [ROLE.admin] },
    schema: { tags: ['settings'], summary: 'Updates the observability settings', body: observabilitySettingsBody, response: { 200: jsonObject, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const parsed = observabilitySettingsSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(msg('analytics.invalidSettings', { reason: parsed.error.issues[0]?.path.join('.') ?? '' }));
      const tenant = await services.repos.tenants.get(tenantId);
      await services.repos.tenants.update(tenantId, { settings: { ...tenant.settings, observability: parsed.data } });
      await services.repos.audit.record(tenantId, { action: 'settings.observability.update', subject: requirePrincipal(req).sub, decision: 'applied' });
      return parsed.data;
    },
  });
};

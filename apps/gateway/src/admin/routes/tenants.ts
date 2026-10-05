import {
  artifactSettingsSchema,
  compositionSettingsSchema,
  Forbidden,
  isSafeRegex,
  MAX_PATTERN_LENGTH,
  piiSettingsSchema,
  readPiiSettings,
  trafficSettingsSchema,
  ValidationError,
} from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { z } from 'zod';
import { isPlatformAdmin, requirePrincipal, ROLE } from '../auth';
import { tenantDto } from '../dto';
import {
  errorResponses,
  noContent,
  page,
  pageQuery,
  tenantCreateSchema,
  tenantPatchSchema,
  tenantSchema,
  uuidParam,
} from '../schemas';
import type { FastifyRequest } from 'fastify';
import type { Services } from '../../services';

/**
 * The data plane reads settings leniently (an invalid section falls back to the defaults), so
 * they are validated on write: limits within their ceilings and regexes safe from ReDoS.
 */
function validateSettings(settings: Record<string, unknown> | undefined): void {
  if (!settings) return;
  const sections: Array<[string, z.ZodType, unknown]> = [
    ['traffic', trafficSettingsSchema, { rateLimits: settings.rateLimits, limits: settings.limits, circuitBreaker: settings.circuitBreaker }],
    ['pii', piiSettingsSchema, settings.pii ?? {}],
    ['composition', compositionSettingsSchema, settings.composition ?? {}],
    ['artifacts', artifactSettingsSchema, settings.artifacts ?? {}],
  ];
  const issues = sections.flatMap(([name, schema, value]) => {
    const r = schema.safeParse(value);
    return r.success ? [] : r.error.issues.map((i) => ({ path: [name === 'traffic' ? '' : name, ...i.path].filter(Boolean).join('.'), message: i.message }));
  });
  if (issues.length) throw new ValidationError(msg('admin.invalidSettings'), issues);
  const pattern = readPiiSettings(settings).bankAccountPattern;
  if (pattern !== undefined && !isSafeRegex(pattern)) throw new ValidationError(msg('config.unsafeRegex', { pattern, max: MAX_PATTERN_LENGTH }));
}

export const tenantRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const { tenants } = services.repos;
  const config = { roles: [ROLE.admin] };
  const tags = ['tenants'];

  /** A tenant admin (ADR-008) only sees and changes its own tenant; the platform admin, any. */
  async function loadTenant(req: FastifyRequest, id: string) {
    const p = requirePrincipal(req);
    const tenant = await tenants.get(id);
    if (!isPlatformAdmin(p) && tenant.slug !== p.tenant) throw new Forbidden(msg('auth.crossTenantForbidden'));
    return tenant;
  }
  const platformOnly = (req: FastifyRequest) => {
    if (!isPlatformAdmin(requirePrincipal(req))) throw new Forbidden(msg('auth.platformAdminOnly'));
  };

  app.get('/tenants', {
    config,
    schema: { tags, querystring: pageQuery, response: { 200: page(tenantSchema), ...errorResponses } },
    handler: async (req) => {
      const p = requirePrincipal(req);
      if (!isPlatformAdmin(p)) {
        const own = p.tenant ? await tenants.findBySlug(p.tenant) : undefined;
        return { items: own ? [tenantDto(own)] : [], total: own ? 1 : 0 };
      }
      const r = await tenants.list(req.query);
      return { items: r.items.map(tenantDto), total: r.total };
    },
  });

  app.post('/tenants', {
    config,
    schema: { tags, body: tenantCreateSchema, response: { 201: tenantSchema, ...errorResponses } },
    handler: async (req, reply) => {
      platformOnly(req);
      validateSettings(req.body.settings);
      return reply.code(201).send(tenantDto(await tenants.create(req.body)));
    },
  });

  app.get('/tenants/:id', {
    config,
    schema: { tags, params: uuidParam, response: { 200: tenantSchema, ...errorResponses } },
    handler: async (req) => tenantDto(await loadTenant(req, req.params.id)),
  });

  app.patch('/tenants/:id', {
    config,
    schema: { tags, params: uuidParam, body: tenantPatchSchema, response: { 200: tenantSchema, ...errorResponses } },
    handler: async (req) => {
      await loadTenant(req, req.params.id);
      // suspending or reactivating a tenant is a platform decision
      if (req.body.status !== undefined) platformOnly(req);
      req.affectedTenantId = req.params.id;
      validateSettings(req.body.settings);
      return tenantDto(await tenants.update(req.params.id, req.body));
    },
  });

  app.delete('/tenants/:id', {
    config,
    schema: { tags, params: uuidParam, response: { ...noContent, ...errorResponses } },
    handler: async (req, reply) => {
      platformOnly(req);
      req.affectedTenantId = req.params.id;
      await tenants.delete(req.params.id);
      return reply.code(204).send(null);
    },
  });
};

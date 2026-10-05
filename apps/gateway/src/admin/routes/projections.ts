import { NotFound, ValidationError } from '@mcp-gateway/core';
import type { Projection } from '@mcp-gateway/db';
import { FIELD_RE, isValidSelector, project, type ProjectionSpec } from '@mcp-gateway/projection';
import { msg } from '@mcp-gateway/i18n/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requestLocale } from '../../i18n';
import type { Services } from '../../services';
import { requirePrincipal, resolveTenantId, ROLE } from '../auth';
import { canManageTool } from './tools';
import { errorResponses, noContent, projectionPreviewSchema, projectionPutSchema, projectionSchema, uuidParam } from '../schemas';

const dto = (p: Projection) => ({
  toolId: p.toolId,
  include: p.include,
  exclude: p.exclude,
  maxArrayItems: p.maxArrayItems,
  maxBytes: p.maxBytes,
  allowAgentFields: p.allowAgentFields,
  status: p.status,
  updatedAt: p.updatedAt.toISOString(),
});

function validateSelectors(list: string[]) {
  const bad = list.filter((s) => !isValidSelector(s));
  if (bad.length) throw new ValidationError(msg('admin.invalidJsonPath'), { selectors: bad });
}

export const projectionRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const { projections, tools, audit } = services.repos;
  const config = { roles: [ROLE.admin, ROLE.owner] };
  const tags = ['projections'];

  async function managed(req: Parameters<typeof resolveTenantId>[1], toolId: string) {
    const tenantId = await resolveTenantId(services, req);
    const tool = await tools.get(tenantId, toolId);
    const p = requirePrincipal(req);
    if (!canManageTool(p, tool)) throw new NotFound('tool', toolId);
    return { tenantId, tool, principal: p };
  }

  app.get('/tools/:id/projection', {
    config,
    schema: { tags, params: uuidParam, response: { 200: projectionSchema, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      await tools.get(tenantId, req.params.id);
      const p = await projections.get(tenantId, req.params.id);
      if (!p) throw new NotFound('projection', req.params.id);
      return dto(p);
    },
  });

  app.put('/tools/:id/projection', {
    config,
    schema: { tags, params: uuidParam, body: projectionPutSchema, response: { 200: projectionSchema, ...errorResponses } },
    handler: async (req) => {
      const { tenantId, tool, principal } = await managed(req, req.params.id);
      validateSelectors([...req.body.include, ...req.body.exclude]);
      const saved = await projections.upsert(tenantId, tool.id, req.body);
      await audit.record(tenantId, {
        action: 'projection.update',
        subject: principal.sub,
        clientId: principal.clientId,
        toolId: tool.id,
        toolName: tool.name,
        decision: 'applied',
        details: { status: saved.status },
      });
      return dto(saved);
    },
  });

  app.post('/tools/:id/projection/approve', {
    config,
    schema: { tags, summary: 'Activates the projection suggested by the crawl', params: uuidParam, response: { 200: projectionSchema, ...errorResponses } },
    handler: async (req) => {
      const { tenantId, tool } = await managed(req, req.params.id);
      const current = await projections.get(tenantId, tool.id);
      if (!current) throw new NotFound('projection', tool.id);
      return dto(await projections.upsert(tenantId, tool.id, { ...current, status: 'active' }));
    },
  });

  app.delete('/tools/:id/projection', {
    config,
    schema: { tags, params: uuidParam, response: { ...noContent, ...errorResponses } },
    handler: async (req, reply) => {
      const { tenantId, tool } = await managed(req, req.params.id);
      if (!(await projections.delete(tenantId, tool.id))) throw new NotFound('projection', tool.id);
      return reply.code(204).send(null);
    },
  });

  app.post('/tools/:id/projection/preview', {
    config,
    schema: {
      tags,
      summary: 'Applies the projection to a sample payload and measures the bytes saved',
      params: uuidParam,
      body: projectionPreviewSchema,
      response: {
        200: z.object({ projected: z.unknown(), bytesBefore: z.number(), bytesAfter: z.number(), bytesSaved: z.number(), ratio: z.number() }),
        ...errorResponses,
      },
    },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      await tools.get(tenantId, req.params.id);
      const spec: ProjectionSpec = req.body.projection ?? (await projections.get(tenantId, req.params.id)) ?? {};
      validateSelectors([...(spec.include ?? []), ...(spec.exclude ?? [])]);
      if (req.body.fields?.some((f) => !FIELD_RE.test(f))) throw new ValidationError(msg('admin.invalidFields'));
      const r = project(req.body.payload, spec, { ...(req.body.fields ? { fields: req.body.fields } : {}), locale: requestLocale(req) });
      const saved = Math.max(0, r.bytesBefore - r.bytesAfter);
      return { projected: r.value, bytesBefore: r.bytesBefore, bytesAfter: r.bytesAfter, bytesSaved: saved, ratio: r.bytesBefore ? saved / r.bytesBefore : 0 };
    },
  });
};

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requestLocale } from '../../i18n';
import { resolveTenantId, ROLE } from '../auth';
import { crawlRunDto, sourceDto } from '../dto';
import { assertAllowedUrls, enqueueCrawl } from '../source-helpers';
import {
  crawlRunSchema,
  errorResponses,
  noContent,
  page,
  pageQuery,
  sourceCreateSchema,
  sourcePatchSchema,
  sourceSchema,
  uuidParam,
} from '../schemas';
import type { Services } from '../../services';

export const sourceRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const { sources, crawlRuns } = services.repos;

  const config = { roles: [ROLE.admin] };
  const tags = ['sources'];

  app.get('/sources', {
    config: { roles: [ROLE.admin, ROLE.owner] },
    schema: { tags, querystring: pageQuery, response: { 200: page(sourceSchema), ...errorResponses } },
    handler: async (req) => {
      const r = await sources.list(await resolveTenantId(services, req), req.query);
      return { items: r.items.map(sourceDto), total: r.total };
    },
  });

  app.post('/sources', {
    config,
    schema: { tags, body: sourceCreateSchema, response: { 201: sourceSchema, ...errorResponses } },
    handler: async (req, reply) => {
      const tenantId = await resolveTenantId(services, req);
      await assertAllowedUrls(services, tenantId, [req.body.baseUrl, req.body.openapiUrl]);
      const created = await sources.create(tenantId, req.body);
      return reply.code(201).send(sourceDto(created));
    },
  });

  app.get('/sources/:id', {
    config: { roles: [ROLE.admin, ROLE.owner] },
    schema: { tags, params: uuidParam, response: { 200: sourceSchema, ...errorResponses } },
    handler: async (req) => sourceDto(await sources.get(await resolveTenantId(services, req), req.params.id)),
  });

  app.patch('/sources/:id', {
    config,
    schema: { tags, params: uuidParam, body: sourcePatchSchema, response: { 200: sourceSchema, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      await assertAllowedUrls(services, tenantId, [req.body.baseUrl, req.body.openapiUrl]);
      return sourceDto(await sources.update(tenantId, req.params.id, req.body));
    },
  });

  app.delete('/sources/:id', {
    config,
    schema: { tags, params: uuidParam, response: { ...noContent, ...errorResponses } },
    handler: async (req, reply) => {
      await sources.delete(await resolveTenantId(services, req), req.params.id);
      return reply.code(204).send(null);
    },
  });

  app.post('/sources/:id/crawl', {
    config: { roles: [ROLE.admin, ROLE.owner] },
    schema: {
      tags,
      summary: 'Enqueues a crawl of the source',
      params: uuidParam,
      response: { 202: crawlRunSchema, ...errorResponses },
    },
    handler: async (req, reply) => {
      const tenantId = await resolveTenantId(services, req);
      const source = await sources.get(tenantId, req.params.id);
      const run = await enqueueCrawl(services, tenantId, source.id);
      return reply.code(202).send(crawlRunDto(run, requestLocale(req)));
    },
  });

  app.get('/sources/:id/crawl-runs', {
    config: { roles: [ROLE.admin, ROLE.owner] },
    schema: { tags, params: uuidParam, response: { 200: z.object({ items: z.array(crawlRunSchema) }), ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      await sources.get(tenantId, req.params.id);
      return { items: (await crawlRuns.listBySource(tenantId, req.params.id)).map((r) => crawlRunDto(r, requestLocale(req))) };
    },
  });

  app.get('/crawl-runs/:id', {
    config: { roles: [ROLE.admin, ROLE.owner] },
    schema: { tags, params: uuidParam, response: { 200: crawlRunSchema, ...errorResponses } },
    handler: async (req) => crawlRunDto(await crawlRuns.get(await resolveTenantId(services, req), req.params.id), requestLocale(req)),
  });
};

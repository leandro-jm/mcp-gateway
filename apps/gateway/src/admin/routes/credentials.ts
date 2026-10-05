import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { resolveTenantId, ROLE } from '../auth';
import { credentialDto } from '../dto';
import {
  credentialCreateSchema,
  credentialPatchSchema,
  credentialSchema,
  errorResponses,
  noContent,
  uuidParam,
} from '../schemas';
import { z } from 'zod';
import type { Services } from '../../services';

export const credentialRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const repo = services.repos.credentials;
  const config = { roles: [ROLE.admin] };
  const tags = ['credentials'];

  app.get('/credentials', {
    config,
    schema: {
      tags,
      response: { 200: z.object({ items: z.array(credentialSchema), total: z.number() }), ...errorResponses },
    },
    handler: async (req) => {
      const items = await repo.list(await resolveTenantId(services, req));
      return { items: items.map(credentialDto), total: items.length };
    },
  });

  app.post('/credentials', {
    config,
    schema: { tags, body: credentialCreateSchema, response: { 201: credentialSchema, ...errorResponses } },
    handler: async (req, reply) => {
      const tenantId = await resolveTenantId(services, req);
      const created = await repo.create(tenantId, req.body);
      return reply.code(201).send(credentialDto(created));
    },
  });

  app.get('/credentials/:id', {
    config,
    schema: { tags, params: uuidParam, response: { 200: credentialSchema, ...errorResponses } },
    handler: async (req) => credentialDto(await repo.get(await resolveTenantId(services, req), req.params.id)),
  });

  app.patch('/credentials/:id', {
    config,
    schema: { tags, params: uuidParam, body: credentialPatchSchema, response: { 200: credentialSchema, ...errorResponses } },
    handler: async (req) =>
      credentialDto(await repo.update(await resolveTenantId(services, req), req.params.id, req.body)),
  });

  app.delete('/credentials/:id', {
    config,
    schema: { tags, params: uuidParam, response: { ...noContent, ...errorResponses } },
    handler: async (req, reply) => {
      await repo.delete(await resolveTenantId(services, req), req.params.id);
      return reply.code(204).send(null);
    },
  });
};

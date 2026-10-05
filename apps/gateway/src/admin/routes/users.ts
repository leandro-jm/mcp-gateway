import { hashPassword, ValidationError } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Services } from '../../services';
import { resolveTenantId, ROLE } from '../auth';
import { apiTokenDto, userDto } from '../dto';
import {
  apiTokenCreatedSchema,
  apiTokenCreateSchema,
  apiTokenSchema,
  errorResponses,
  noContent,
  page,
  pageQuery,
  passwordSchema,
  tokenParams,
  userCreateSchema,
  userPatchSchema,
  userSchema,
  uuidParam,
} from '../schemas';
import { expiresInDays, issueToken } from './auth';

/** Tenant users and their API tokens (ADR-011). `gateway-admin` only. */
export const userRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const { users, apiTokens } = services.repos;
  const config = { roles: [ROLE.admin] };
  const tags = ['users'];

  app.get('/users', {
    config,
    schema: { tags, querystring: pageQuery, response: { 200: page(userSchema), ...errorResponses } },
    handler: async (req) => {
      const r = await users.list(await resolveTenantId(services, req), req.query);
      return { items: r.items.map(userDto), total: r.total };
    },
  });

  app.post('/users', {
    config,
    schema: { tags, body: userCreateSchema, response: { 201: userSchema, ...errorResponses } },
    handler: async (req, reply) => {
      const tenantId = await resolveTenantId(services, req);
      const { password, ...input } = req.body;
      if (password && input.kind === 'service') throw new ValidationError(msg('auth.serviceUserNoPassword'));
      const user = await users.create(tenantId, { ...input, passwordHash: password ? await hashPassword(password) : null });
      return reply.code(201).send(userDto(user));
    },
  });

  app.get('/users/:id', {
    config,
    schema: { tags, params: uuidParam, response: { 200: userSchema, ...errorResponses } },
    handler: async (req) => userDto(await users.get(await resolveTenantId(services, req), req.params.id)),
  });

  app.patch('/users/:id', {
    config,
    schema: { tags, params: uuidParam, body: userPatchSchema, response: { 200: userSchema, ...errorResponses } },
    handler: async (req) => {
      const user = await users.update(await resolveTenantId(services, req), req.params.id, req.body);
      // Roles, groups, status and locale apply to tokens already issued.
      services.verifier.clear();
      return userDto(user);
    },
  });

  app.delete('/users/:id', {
    config,
    schema: { tags, params: uuidParam, response: { ...noContent, ...errorResponses } },
    handler: async (req, reply) => {
      const tenantId = await resolveTenantId(services, req);
      const hashes = await apiTokens.activeHashes(tenantId, req.params.id);
      await users.delete(tenantId, req.params.id);
      services.verifier.forget(...hashes);
      return reply.code(204).send(null);
    },
  });

  app.put('/users/:id/password', {
    config,
    schema: { tags, summary: 'Sets the password of a human user', params: uuidParam, body: passwordSchema, response: { ...noContent, ...errorResponses } },
    handler: async (req, reply) => {
      const tenantId = await resolveTenantId(services, req);
      const user = await users.get(tenantId, req.params.id);
      if (user.kind !== 'human') throw new ValidationError(msg('auth.serviceUserNoPassword'));
      await users.setPasswordHash(tenantId, user.id, await hashPassword(req.body.password));
      // a reset usually follows a suspected compromise: end the sessions and what they may have minted
      services.verifier.forget(...(await apiTokens.revokeUserIssued(tenantId, user.id)));
      return reply.code(204).send(null);
    },
  });

  app.get('/users/:id/tokens', {
    config,
    schema: { tags, params: uuidParam, response: { 200: z.object({ items: z.array(apiTokenSchema) }), ...errorResponses } },
    handler: async (req) => ({ items: (await apiTokens.list(await resolveTenantId(services, req), req.params.id)).map(apiTokenDto) }),
  });

  app.post('/users/:id/tokens', {
    config,
    schema: { tags, summary: 'Creates an API token for the user', params: uuidParam, body: apiTokenCreateSchema, response: { 201: apiTokenCreatedSchema, ...errorResponses } },
    handler: async (req, reply) => {
      const tenantId = await resolveTenantId(services, req);
      const issued = await issueToken((input) => apiTokens.create(tenantId, req.params.id, input), req.body.name, {
        expiresAt: expiresInDays(req.body.expiresInDays),
      });
      return reply.code(201).send({ ...apiTokenDto(issued), token: issued.token });
    },
  });

  app.delete('/users/:id/tokens/:tokenId', {
    config,
    schema: { tags, params: tokenParams, response: { ...noContent, ...errorResponses } },
    handler: async (req, reply) => {
      const hash = await apiTokens.revoke(await resolveTenantId(services, req), req.params.id, req.params.tokenId);
      services.verifier.forget(hash);
      return reply.code(204).send(null);
    },
  });
};

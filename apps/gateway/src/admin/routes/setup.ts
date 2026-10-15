import { createHash, timingSafeEqual } from 'node:crypto';
import { Conflict, Forbidden, hashPassword, Unauthorized } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Services } from '../../services';
import { errorResponses, errorSchema, setupResultSchema, setupSchema, setupStatusSchema } from '../schemas';
import { issueToken } from './auth';

/** Constant-time comparison of two secrets of any length (both hashed to the same size first). */
function sameSecret(given: string, expected: string): boolean {
  const digest = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * First-run setup (ADR-024): on an instance without users, creates the first tenant and a platform
 * admin from the Admin UI, guarded by the SETUP_TOKEN secret. Once a user exists it never acts again.
 */
export const setupRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const { auth } = services.repos;
  const tags = ['auth'];

  app.get('/setup', {
    config: { public: true },
    schema: {
      tags,
      summary: 'Whether the first-run setup is needed (no user yet) and enabled (SETUP_TOKEN set)',
      security: [],
      response: { 200: setupStatusSchema },
    },
    handler: async () => {
      const needed = !(await auth.hasUsers());
      return { needed, enabled: needed && Boolean(services.config.SETUP_TOKEN) };
    },
  });

  app.post('/setup', {
    config: { public: true },
    schema: {
      tags,
      summary: 'Creates the first tenant and platform admin; returns a session token',
      security: [],
      body: setupSchema,
      response: { 200: setupResultSchema, 429: errorSchema, ...errorResponses },
    },
    handler: async (req) => {
      await services.rateLimiter.check([{ scope: 'setup', key: `setup:${req.ip}`, limit: { limit: 10, windowSec: 900 } }]);
      const expected = services.config.SETUP_TOKEN;
      if (!expected) throw new Forbidden(msg('auth.setupDisabled'));
      if (await auth.hasUsers()) throw new Conflict(msg('auth.setupDone'));
      if (!sameSecret(req.body.setupToken, expected)) throw new Unauthorized(msg('auth.invalidSetupToken'));

      const { username, password, locale, tenant } = req.body;
      const created = await auth.bootstrap({
        tenant,
        admin: { username, displayName: username, locale, passwordHash: await hashPassword(password) },
      });
      if (!created) throw new Conflict(msg('auth.setupDone'));
      req.log.info({ tenant: created.tenant.slug }, 'first-run setup completed');

      const expiresAt = new Date(Date.now() + services.config.AUTH_SESSION_TTL_HOURS * 60 * 60 * 1000);
      const issued = await issueToken((input) => auth.createToken(created.user.id, input), 'admin-ui', { kind: 'session', expiresAt });
      return { token: issued.token, expiresAt: expiresAt.toISOString(), tenant: created.tenant.slug };
    },
  });
};

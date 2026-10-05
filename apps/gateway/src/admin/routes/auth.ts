import { Forbidden, generateApiToken, hashToken, Unauthorized, verifyPassword } from '@mcp-gateway/core';
import type { ApiToken, ApiTokenInput } from '@mcp-gateway/db';
import { msg } from '@mcp-gateway/i18n/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { bearerToken } from '../../auth/tokens';
import type { Services } from '../../services';
import { requirePrincipal } from '../auth';
import { apiTokenDto } from '../dto';
import {
  apiTokenCreatedSchema,
  apiTokenSchema,
  errorResponses,
  errorSchema,
  loginResultSchema,
  loginSchema,
  meTokenCreateSchema,
  noContent,
  uuidParam,
} from '../schemas';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Generates an opaque token, persists only its hash and returns the value exactly once. */
export async function issueToken(
  create: (input: ApiTokenInput) => Promise<ApiToken>,
  name: string,
  opts: { kind?: ApiToken['kind']; expiresAt?: Date | null; selfIssued?: boolean } = {},
): Promise<ApiToken & { token: string }> {
  const t = generateApiToken();
  const row = await create({
    name,
    kind: opts.kind ?? 'api',
    selfIssued: opts.selfIssued ?? false,
    tokenHash: t.hash,
    prefix: t.prefix,
    expiresAt: opts.expiresAt ?? null,
  });
  return { ...row, token: t.token };
}

export const expiresInDays = (days: number | undefined) => (days ? new Date(Date.now() + days * DAY_MS) : null);

/**
 * Reference hash for unknown usernames: verification takes the same time,
 * without revealing which usernames exist.
 */
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** Admin UI login, logout and the user's own tokens (ADR-011). */
export const authRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const { auth } = services.repos;
  const tags = ['auth'];

  app.post('/auth/login', {
    config: { public: true },
    schema: {
      tags,
      summary: 'Login with username and password; returns a session token',
      security: [],
      body: loginSchema,
      response: { 200: loginResultSchema, 429: errorSchema, ...errorResponses },
    },
    handler: async (req) => {
      const { username, password } = req.body;
      const user = username.toLowerCase();
      await services.rateLimiter.check([
        { scope: 'login', key: `login:${user}:${req.ip}`, limit: { limit: services.config.AUTH_LOGIN_RATE_LIMIT, windowSec: 300 } },
        // the IP may come from a header: a per-user ceiling bounds guessing from many addresses
        { scope: 'login', key: `login-user:${user}`, limit: { limit: services.config.AUTH_LOGIN_USER_RATE_LIMIT, windowSec: 900 } },
      ]);
      const rec = await auth.findLogin(username);
      const ok = await verifyPassword(password, rec?.passwordHash ?? DUMMY_HASH);
      const fail = () => new Unauthorized(msg('auth.invalidCredentials'));
      if (!rec || !ok || rec.user.kind !== 'human' || rec.user.status !== 'active') throw fail();
      if (rec.tenant && rec.tenant.status !== 'active') throw fail();
      const expiresAt = new Date(Date.now() + services.config.AUTH_SESSION_TTL_HOURS * 60 * 60 * 1000);
      const issued = await issueToken((input) => auth.createToken(rec.user.id, input), 'admin-ui', { kind: 'session', expiresAt });
      return { token: issued.token, expiresAt: expiresAt.toISOString() };
    },
  });

  app.post('/auth/logout', {
    schema: { tags, summary: 'Revokes the token used in the request', response: { ...noContent, ...errorResponses } },
    handler: async (req, reply) => {
      const hash = hashToken(bearerToken(req.headers.authorization)!);
      await auth.revokeByHash(hash);
      services.verifier.forget(hash);
      return reply.code(204).send(null);
    },
  });

  const userIdOf = (req: Parameters<typeof requirePrincipal>[0]) => {
    const id = requirePrincipal(req).userId;
    if (!id) throw new Unauthorized();
    return id;
  };

  app.get('/me/tokens', {
    schema: { tags, summary: "The authenticated user's API tokens", response: { 200: z.object({ items: z.array(apiTokenSchema) }), ...errorResponses } },
    handler: async (req) => ({ items: (await auth.listTokens(userIdOf(req))).map(apiTokenDto) }),
  });

  app.post('/me/tokens', {
    schema: { tags, summary: 'Creates an API token for the authenticated user', body: meTokenCreateSchema, response: { 201: apiTokenCreatedSchema, ...errorResponses } },
    handler: async (req, reply) => {
      const userId = userIdOf(req);
      // Service users (agents) get their tokens from an admin: a leaked agent token cannot mint more.
      if (requirePrincipal(req).kind !== 'human') throw new Forbidden(msg('auth.selfTokensHumanOnly'));
      const issued = await issueToken((input) => auth.createToken(userId, input), req.body.name, {
        expiresAt: expiresInDays(req.body.expiresInDays),
        selfIssued: true,
      });
      return reply.code(201).send({ ...apiTokenDto(issued), token: issued.token });
    },
  });

  app.delete('/me/tokens/:id', {
    schema: { tags, params: uuidParam, response: { ...noContent, ...errorResponses } },
    handler: async (req, reply) => {
      services.verifier.forget(await auth.revokeToken(userIdOf(req), req.params.id));
      return reply.code(204).send(null);
    },
  });
};

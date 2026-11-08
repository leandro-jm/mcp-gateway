import { randomBytes } from 'node:crypto';
import {
  generateApiToken,
  generateSecret,
  hashToken,
  RateLimited,
  readOAuthSettings,
  REFRESH_TOKEN_PREFIX,
} from '@mcp-gateway/core';
import type { GrantWithClient } from '@mcp-gateway/db';
import { msg, translate } from '@mcp-gateway/i18n/server';
import {
  clientInAllowlist,
  coversScopes,
  formatScope,
  OAUTH_PATHS,
  oauthErrorBody,
  OAuthProtocolError,
  parseRegistrationRequest,
  parseTokenRequest,
  registrationResponse,
  SCOPE_OFFLINE_ACCESS,
  single,
  verifyPkceS256,
  type OAuthParams,
} from '@mcp-gateway/oauth';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { oauthClientId } from '../auth/tokens';
import type { Services } from '../services';
import { publicCors } from './metadata';

const TOKEN_RATE = { limit: 120, windowSec: 60 };
const REGISTER_RATE = { limit: 20, windowSec: 3600 };
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** RFC 6749 §5.1 headers: token responses are never cached. */
function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
}

function sendError(reply: FastifyReply, err: OAuthProtocolError): FastifyReply {
  const description = translate(msg(`oauth.reason.${err.reason}`, err.param ? { param: err.param } : undefined));
  const status = err.reason === 'rate_limited' ? 429 : err.status;
  return noStore(reply).code(status).type('application/json').send(oauthErrorBody(err.code, description));
}

/**
 * Token, revocation and registration endpoints (ADR-030). Public clients only: the proof of
 * possession is PKCE for codes and the client binding for refresh tokens. Redeeming a code or a
 * refresh token twice revokes the whole grant (RFC 9700 §4.5, §4.14).
 */
export async function tokenRoutes(app: FastifyInstance, services: Services): Promise<void> {
  const { config, repos, verifier } = services;
  const opts = { schema: { hide: true } };

  const limit = async (scope: string, key: string, rate: { limit: number; windowSec: number }) => {
    try {
      await services.rateLimiter.check([{ scope, key, limit: rate }]);
    } catch (err) {
      if (err instanceof RateLimited) throw new OAuthProtocolError('invalid_request', 'rate_limited');
      throw err;
    }
  };

  /** Wraps a handler: CORS, OAuth errors in the RFC 6749 format, nothing cached. */
  const endpoint =
    (handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) => async (req: FastifyRequest, reply: FastifyReply) => {
      publicCors(reply, 'POST, OPTIONS');
      try {
        return await handler(req, reply);
      } catch (err) {
        if (err instanceof OAuthProtocolError) return sendError(reply, err);
        throw err;
      }
    };

  async function revokeGrant(grantId: string, reason: 'code_reused' | 'refresh_token_reused') {
    const found = await repos.oauth.findGrant(grantId);
    verifier.forget(...(await repos.oauth.revokeGrant(grantId)));
    if (found) {
      await repos.audit.record(found.grant.tenantId, {
        action: 'oauth.grant.revoke',
        clientId: oauthClientId({ clientId: found.client.clientId, clientKind: found.client.kind }),
        decision: 'deny',
        details: { grantId, reason },
      });
    }
  }

  /** The grant must still be usable: active user and tenant, OAuth on, app allowed. Returns the tenant's TTLs. */
  async function usableGrant({ grant, client }: GrantWithClient) {
    const tenant = await repos.tenants.get(grant.tenantId);
    const user = await repos.users.get(grant.tenantId, grant.userId).catch(() => undefined);
    if (tenant.status !== 'active' || user?.status !== 'active' || user.kind !== 'human') {
      throw new OAuthProtocolError('invalid_grant', 'user_not_allowed');
    }
    const settings = readOAuthSettings(tenant.settings);
    if (!settings.enabled) throw new OAuthProtocolError('invalid_grant', 'tenant_oauth_disabled');
    if (settings.clients === 'allowlist' && !clientInAllowlist(settings.allowlist, { clientId: client.clientId, kind: client.kind })) {
      throw new OAuthProtocolError('invalid_grant', 'client_not_allowed');
    }
    return {
      accessMinutes: Math.min(config.OAUTH_ACCESS_TTL_MINUTES, settings.accessTtlMinutes ?? Infinity),
      refreshDays: Math.min(config.OAUTH_REFRESH_TTL_DAYS, settings.refreshTtlDays ?? Infinity),
    };
  }

  /** Issues the access token, and a refresh token when the grant has `offline_access`. */
  async function issueTokens(found: GrantWithClient, ttl: { accessMinutes: number; refreshDays: number }, rotatedRefresh?: string) {
    const { grant, client } = found;
    const access = generateApiToken();
    await repos.auth.createToken(grant.userId, {
      name: oauthClientId({ clientId: client.clientId, clientKind: client.kind }),
      kind: 'oauth',
      tokenHash: access.hash,
      prefix: access.prefix,
      expiresAt: new Date(Date.now() + ttl.accessMinutes * MINUTE_MS),
      grantId: grant.id,
    });
    await repos.oauth.touchClient(client.id);
    let refreshToken = rotatedRefresh;
    if (!rotatedRefresh && grant.scopes.includes(SCOPE_OFFLINE_ACCESS)) {
      const secret = generateSecret(REFRESH_TOKEN_PREFIX);
      await repos.oauth.createRefreshToken(grant.id, secret.hash, new Date(Date.now() + ttl.refreshDays * DAY_MS));
      refreshToken = secret.token;
    }
    return {
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: ttl.accessMinutes * 60,
      scope: formatScope(grant.scopes),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    };
  }

  app.post(
    OAUTH_PATHS.token,
    opts,
    endpoint(async (req, reply) => {
      await limit('oauth-token', `oauth-token:${req.ip}`, TOKEN_RATE);
      const params = (req.body ?? {}) as OAuthParams;
      const request = parseTokenRequest(params, config.PUBLIC_URL);

      if (request.grantType === 'authorization_code') {
        const redeemed = await repos.oauth.redeemCode(hashToken(request.code));
        if (redeemed.status === 'reused') {
          await revokeGrant(redeemed.grantId, 'code_reused');
          throw new OAuthProtocolError('invalid_grant', 'code_reused');
        }
        if (redeemed.status === 'invalid') throw new OAuthProtocolError('invalid_grant', 'invalid_code');
        const code = redeemed.value;
        if (code.client.clientId !== request.clientId) throw new OAuthProtocolError('invalid_grant', 'client_mismatch');
        // RFC 6749 §4.1.3: identical to the one in the authorization request
        if (code.redirectUri !== request.redirectUri) throw new OAuthProtocolError('invalid_grant', 'redirect_uri_mismatch');
        if (!verifyPkceS256(request.codeVerifier, code.codeChallenge)) throw new OAuthProtocolError('invalid_grant', 'pkce_mismatch');
        if (request.resource && request.resource !== code.resource) throw new OAuthProtocolError('invalid_target', 'resource_mismatch');
        const ttl = await usableGrant(code);
        return noStore(reply).send(await issueTokens(code, ttl));
      }

      // refresh_token: check the client before rotating, so a token sent by another client stays valid
      const tokenHash = hashToken(request.refreshToken);
      const owner = await repos.oauth.findRefreshTokenGrant(tokenHash);
      if (!owner) throw new OAuthProtocolError('invalid_grant', 'invalid_refresh_token');
      if (owner.client.clientId !== request.clientId) throw new OAuthProtocolError('invalid_grant', 'client_mismatch');
      if (request.scopes && !coversScopes(owner.grant.scopes, request.scopes)) throw new OAuthProtocolError('invalid_scope', 'invalid_scope', 'scope');
      const ttl = await usableGrant(owner);
      const next = generateSecret(REFRESH_TOKEN_PREFIX);
      const rotated = await repos.oauth.rotateRefreshToken(tokenHash, {
        tokenHash: next.hash,
        expiresAt: new Date(Date.now() + ttl.refreshDays * DAY_MS),
      });
      if (rotated.status === 'reused') {
        await revokeGrant(rotated.grantId, 'refresh_token_reused');
        throw new OAuthProtocolError('invalid_grant', 'refresh_token_reused');
      }
      if (rotated.status === 'invalid') throw new OAuthProtocolError('invalid_grant', 'invalid_refresh_token');
      return noStore(reply).send(await issueTokens(rotated.value, ttl, next.token));
    }),
  );

  // RFC 7009: the answer is 200 whether or not the token existed, so it reveals nothing.
  app.post(
    OAUTH_PATHS.revoke,
    opts,
    endpoint(async (req, reply) => {
      await limit('oauth-token', `oauth-token:${req.ip}`, TOKEN_RATE);
      const params = (req.body ?? {}) as OAuthParams;
      const token = single(params, 'token');
      const clientId = single(params, 'client_id');
      if (!token) throw new OAuthProtocolError('invalid_request', 'invalid_parameter', 'token');
      if (!clientId) throw new OAuthProtocolError('invalid_request', 'missing_client_id', 'client_id');
      const hash = hashToken(token);
      if (token.startsWith(REFRESH_TOKEN_PREFIX)) {
        const owner = await repos.oauth.findRefreshTokenGrant(hash);
        if (owner && owner.client.clientId === clientId && !owner.grant.revokedAt) verifier.forget(...(await repos.oauth.revokeGrant(owner.grant.id)));
      } else {
        const record = await repos.auth.findToken(hash);
        if (record?.oauth && record.oauth.clientId === clientId) {
          await repos.auth.revokeByHash(hash);
          verifier.forget(hash);
        }
      }
      return noStore(reply).code(200).send();
    }),
  );

  if (config.OAUTH_DCR_ENABLED) {
    app.post(
      OAUTH_PATHS.register,
      opts,
      endpoint(async (req, reply) => {
        await limit('oauth-register', `oauth-register:${req.ip}`, REGISTER_RATE);
        const registration = parseRegistrationRequest(req.body);
        const client = await repos.oauth.createDcrClient({
          clientId: `dcr_${randomBytes(16).toString('base64url')}`,
          clientName: registration.clientName || new URL(registration.redirectUris[0]!).host || 'MCP client',
          clientUri: registration.clientUri ?? null,
          redirectUris: registration.redirectUris,
          applicationType: registration.applicationType,
          grantTypes: registration.grantTypes,
        });
        return noStore(reply).code(201).send(registrationResponse(client.clientId, client.createdAt, registration));
      }),
    );
  }

  const preflight = (url: string) => app.options(url, opts, (_req, reply) => publicCors(reply, 'POST, OPTIONS').code(204).send());
  preflight(OAUTH_PATHS.token);
  preflight(OAUTH_PATHS.revoke);
  if (config.OAUTH_DCR_ENABLED) preflight(OAUTH_PATHS.register);
}

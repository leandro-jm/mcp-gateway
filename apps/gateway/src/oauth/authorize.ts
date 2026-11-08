import { AUTHORIZATION_CODE_PREFIX, generateSecret, RateLimited, readOAuthSettings } from '@mcp-gateway/core';
import type { LoginRecord, OAuthGrant } from '@mcp-gateway/db';
import { negotiate, type Locale } from '@mcp-gateway/i18n';
import { msg, translate, type ServerMessage } from '@mcp-gateway/i18n/server';
import {
  buildRedirect,
  clientInAllowlist,
  coversScopes,
  issuerOf,
  OAUTH_PATHS,
  OAuthProtocolError,
  parseAuthorizationRequest,
  parseAuthorizationTarget,
  readState,
  redirectUriMatches,
  type OAuthErrorReason,
} from '@mcp-gateway/oauth';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { checkPasswordLogin } from '../auth/login';
import { oauthClientId } from '../auth/tokens';
import type { Services } from '../services';
import type { OAuthClientResolver } from './clients';
import { BROWSER_COOKIE, field, readCookie, setBrowserCookie } from './forms';
import { consentPage, errorPage, loginPage, pageHeaders } from './pages';
import { PENDING_TTL_SECONDS, type PendingAuthorization, type PendingAuthorizations } from './pending';

/** Authorization requests started per IP per minute (each may fetch a CIMD document). */
const AUTHORIZE_RATE = { limit: 60, windowSec: 60 };

export interface AuthorizeDeps {
  clients: OAuthClientResolver;
  pending: PendingAuthorizations;
}

const reasonMessage = (reason: OAuthErrorReason, param?: string): ServerMessage => msg(`oauth.reason.${reason}`, param ? { param } : undefined);

/**
 * `GET /oauth/authorize` and the login and consent forms (ADR-030). Until the redirect URI is known
 * to belong to the client, every error is a page; afterwards, protocol errors go back to the client
 * with `state` and `iss` (RFC 9207). Problems with the user (wrong password, tenant without OAuth,
 * app not allowed) stay on the login page so the person can try another account.
 */
export async function authorizeRoutes(app: FastifyInstance, services: Services, deps: AuthorizeDeps): Promise<void> {
  const { config, repos } = services;
  const issuer = issuerOf(config.PUBLIC_URL);
  const basePath = new URL(issuer).pathname.replace(/\/$/, '');
  const secure = issuer.startsWith('https:');
  const actions = { login: `${basePath}${OAUTH_PATHS.authorize}/login`, consent: `${basePath}${OAUTH_PATHS.authorize}/consent` };
  const opts = { schema: { hide: true } };

  const html = (reply: FastifyReply, status: number, body: string, redirectUri?: string) =>
    pageHeaders(reply, redirectUri).code(status).type('text/html; charset=utf-8').send(body);
  const fail = (reply: FastifyReply, locale: Locale, status: number, message: ServerMessage) => html(reply, status, errorPage(locale, message));
  /** An error page for a request that never reaches the client; counted by reason. */
  const failReason = (reply: FastifyReply, locale: Locale, status: number, reason: OAuthErrorReason, param?: string) => {
    services.metrics.oauthErrors.inc({ endpoint: 'authorize', reason });
    services.metrics.oauthAuthorizations.inc({ outcome: 'request_error' });
    return fail(reply, locale, status, reasonMessage(reason, param));
  };
  const redirect = (reply: FastifyReply, url: string) => pageHeaders(reply).code(303).header('location', url).send();

  /** Protocol error sent to the client; descriptions stay in English for the client's logs. */
  const redirectError = (reply: FastifyReply, redirectUri: string, err: OAuthProtocolError, state: string | undefined) => {
    services.metrics.oauthErrors.inc({ endpoint: 'authorize', reason: err.reason });
    services.metrics.oauthAuthorizations.inc({ outcome: err.reason === 'user_denied' ? 'user_denied' : 'request_error' });
    return redirect(
      reply,
      buildRedirect(redirectUri, {
        error: err.code,
        error_description: translate(reasonMessage(err.reason, err.param)),
        state,
        iss: issuer,
      }),
    );
  };

  const showLogin = (reply: FastifyReply, status: number, locale: Locale, pending: PendingAuthorization, error?: ServerMessage, username?: string) =>
    html(reply, status, loginPage({ locale, pending, action: actions.login, error, username }), pending.request.redirectUri);

  /** Why this user may not connect this app, or `undefined` when they may. */
  async function denialOf(rec: LoginRecord, pending: PendingAuthorization): Promise<OAuthErrorReason | undefined> {
    if (!rec.tenant) return 'user_not_allowed';
    const tenant = await repos.tenants.get(rec.tenant.id);
    const settings = readOAuthSettings(tenant.settings);
    if (!settings.enabled) return 'tenant_oauth_disabled';
    const allowed = settings.clients === 'any' || clientInAllowlist(settings.allowlist, { clientId: pending.client.clientId, kind: pending.client.kind });
    return allowed ? undefined : 'client_not_allowed';
  }

  /** Stores a single-use code for the grant and sends the browser back to the client. */
  async function issueCode(reply: FastifyReply, pending: PendingAuthorization, grant: OAuthGrant, outcome: 'code_issued' | 'consent_skipped') {
    const { request } = pending;
    const code = generateSecret(AUTHORIZATION_CODE_PREFIX);
    await repos.oauth.createCode({
      codeHash: code.hash,
      grantId: grant.id,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      resource: request.resource,
      scopes: request.scopes,
      expiresAt: new Date(Date.now() + config.OAUTH_CODE_TTL_SECONDS * 1000),
    });
    await repos.oauth.touchClient(pending.client.rowId);
    services.metrics.oauthAuthorizations.inc({ outcome });
    return redirect(reply, buildRedirect(request.redirectUri, { code: code.token, state: request.state, iss: issuer }));
  }

  const audit = (pending: PendingAuthorization, action: string, decision: 'allow' | 'deny', grantId?: string) =>
    repos.audit.record(pending.user!.tenantId, {
      action,
      subject: pending.user!.username,
      clientId: oauthClientId({ clientId: pending.client.clientId, clientKind: pending.client.kind }),
      decision,
      details: { scopes: pending.request.scopes, ...(grantId ? { grantId } : {}) },
    });

  app.get(OAUTH_PATHS.authorize, opts, async (req: FastifyRequest, reply) => {
    const locale = negotiate(req.headers['accept-language']);
    const query = (req.query ?? {}) as Record<string, unknown>;
    try {
      await services.rateLimiter.check([{ scope: 'oauth-authorize', key: `oauth-authorize:${req.ip}`, limit: AUTHORIZE_RATE }]);
    } catch (err) {
      if (err instanceof RateLimited) return failReason(reply, locale, 429, 'rate_limited');
      throw err;
    }
    let target;
    let client;
    try {
      target = parseAuthorizationTarget(query);
      client = await deps.clients.resolve(target.clientId);
    } catch (err) {
      if (err instanceof OAuthProtocolError) return failReason(reply, locale, 400, err.reason, err.param);
      throw err;
    }
    if (!redirectUriMatches(client.redirectUris, target.redirectUri)) return failReason(reply, locale, 400, 'redirect_uri_mismatch');
    let request;
    try {
      request = parseAuthorizationRequest(query, target, config.PUBLIC_URL);
    } catch (err) {
      if (err instanceof OAuthProtocolError) return redirectError(reply, target.redirectUri, err, readState(query));
      throw err;
    }
    const { pending, browser } = await deps.pending.create(request, {
      rowId: client.id,
      clientId: client.clientId,
      kind: client.kind,
      name: client.clientName,
    });
    setBrowserCookie(reply, browser, { path: `${basePath}${OAUTH_PATHS.authorize}`, secure, maxAgeSeconds: PENDING_TTL_SECONDS });
    return showLogin(reply, 200, locale, pending);
  });

  app.post(actions.login.slice(basePath.length), opts, async (req, reply) => {
    const locale = negotiate(req.headers['accept-language']);
    const pending = await deps.pending.get(field(req.body, 'request_id', 64), field(req.body, 'csrf', 64), readCookie(req, BROWSER_COOKIE));
    if (!pending) return failReason(reply, locale, 400, 'request_expired');
    const username = field(req.body, 'username', 256);
    let rec: LoginRecord | undefined;
    try {
      rec = await checkPasswordLogin(services, req.ip, username, field(req.body, 'password', 1024));
    } catch (err) {
      if (err instanceof RateLimited) {
        services.metrics.oauthAuthorizations.inc({ outcome: 'login_refused' });
        return showLogin(reply, 429, locale, pending, msg('oauth.login.rateLimited'), username);
      }
      throw err;
    }
    if (!rec) {
      services.metrics.oauthAuthorizations.inc({ outcome: 'login_refused' });
      return showLogin(reply, 401, locale, pending, msg('oauth.login.failed'), username);
    }
    const denial = await denialOf(rec, pending);
    if (denial) {
      services.metrics.oauthAuthorizations.inc({ outcome: 'login_refused' });
      services.metrics.oauthErrors.inc({ endpoint: 'authorize', reason: denial });
      return showLogin(reply, 403, locale, pending, reasonMessage(denial), username);
    }

    pending.user = { id: rec.user.id, username: rec.user.username, tenantId: rec.tenant!.id, tenantSlug: rec.tenant!.slug, locale: rec.user.locale };
    const existing = await repos.oauth.findActiveGrant(rec.user.id, pending.client.rowId);
    if (existing && coversScopes(existing.scopes, pending.request.scopes)) {
      // already approved with these scopes: no second consent (ADR-030)
      if (!(await deps.pending.consume(pending.id))) return failReason(reply, locale, 400, 'request_expired');
      return issueCode(reply, pending, existing, 'consent_skipped');
    }
    await deps.pending.save(pending);
    return html(reply, 200, consentPage({ locale: rec.user.locale, pending, action: actions.consent }), pending.request.redirectUri);
  });

  app.post(actions.consent.slice(basePath.length), opts, async (req, reply) => {
    const locale = negotiate(req.headers['accept-language']);
    const pending = await deps.pending.get(field(req.body, 'request_id', 64), field(req.body, 'csrf', 64), readCookie(req, BROWSER_COOKIE));
    if (!pending?.user || !(await deps.pending.consume(pending.id))) return failReason(reply, locale, 400, 'request_expired');
    const { request, user } = pending;

    if (field(req.body, 'decision', 16) !== 'approve') {
      await audit(pending, 'oauth.grant.deny', 'deny');
      return redirectError(reply, request.redirectUri, new OAuthProtocolError('access_denied', 'user_denied'), request.state);
    }
    // the user or the tenant may have changed while the consent page was open
    const rec = await repos.auth.findLogin(user.username);
    const denial = !rec || rec.user.status !== 'active' || rec.tenant?.status !== 'active' ? 'user_not_allowed' : await denialOf(rec, pending);
    if (denial) return redirectError(reply, request.redirectUri, new OAuthProtocolError('access_denied', denial), request.state);

    const grant = await repos.oauth.saveGrant({
      tenantId: user.tenantId,
      userId: user.id,
      clientId: pending.client.rowId,
      scopes: request.scopes,
      resource: request.resource,
    });
    await audit(pending, 'oauth.grant.approve', 'allow', grant.id);
    return issueCode(reply, pending, grant, 'code_issued');
  });
}

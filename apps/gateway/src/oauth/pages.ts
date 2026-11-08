import { createHash } from 'node:crypto';
import type { Locale } from '@mcp-gateway/i18n';
import { msg, translate, type ServerMessage, type ServerMessageKey } from '@mcp-gateway/i18n/server';
import { isLoopbackRedirect } from '@mcp-gateway/oauth';
import type { FastifyReply } from 'fastify';
import type { PendingAuthorization } from './pending';

/**
 * Login, consent and error pages of the authorization server (ADR-030). Plain HTML without
 * scripts: every dynamic value is escaped, the stylesheet is allowed by hash, frames are refused
 * and forms may only post here or follow the redirect to the client.
 */

const CSS = `:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#1d2129;--muted:#5b6472;--line:#d9dde3;--accent:#2f5bd3;--warn-bg:#fff6e0;--warn:#7a5200;--err-bg:#fdecec;--err:#a32020}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--card:#1a1f26;--text:#e7eaee;--muted:#9aa4b2;--line:#2c333d;--accent:#7d9bff;--warn-bg:#3a2f12;--warn:#f3cf7a;--err-bg:#3b1717;--err:#ff9c9c}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--text);display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 8px}p{margin:0 0 12px}.muted{color:var(--muted);font-size:14px}
label{display:block;font-size:14px;margin:12px 0 4px}input{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
.actions{display:flex;gap:8px;margin-top:20px}button{flex:1;padding:10px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}ul{padding-left:20px;margin:0 0 12px}
.box{border-radius:8px;padding:10px 12px;margin:12px 0;font-size:14px}.warn{background:var(--warn-bg);color:var(--warn)}.error{background:var(--err-bg);color:var(--err)}
footer{margin-top:20px;font-size:12px;color:var(--muted)}`;

const CSS_HASH = createHash('sha256').update(CSS).digest('base64');

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const t = (locale: Locale, key: ServerMessageKey, params?: Record<string, string>) => escape(translate(msg(key, params), locale));

/** CSP source that lets a form submission follow the redirect to the client (Chrome checks redirects too). */
export function formActionSource(redirectUri: string): string {
  const url = new URL(redirectUri);
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : url.protocol;
}

/** Headers of every authorization page and redirect: no caching, no referrer, no framing. */
export function pageHeaders(reply: FastifyReply, redirectUri?: string): FastifyReply {
  const formAction = redirectUri ? `'self' ${formActionSource(redirectUri)}` : `'self'`;
  return reply
    .header('content-security-policy', `default-src 'none'; style-src 'sha256-${CSS_HASH}'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`)
    .header('x-frame-options', 'DENY')
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
    .header('cache-control', 'no-store')
    .header('pragma', 'no-cache');
}

function layout(locale: Locale, body: string): string {
  return `<!doctype html><html lang="${escape(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${t(locale, 'oauth.page.title')}</title><style>${CSS}</style></head><body><main>${body}<footer>MCP Gateway</footer></main></body></html>`;
}

function hidden(pending: PendingAuthorization): string {
  return `<input type="hidden" name="request_id" value="${escape(pending.id)}"><input type="hidden" name="csrf" value="${escape(pending.csrf)}">`;
}

export interface LoginPageOptions {
  locale: Locale;
  pending: PendingAuthorization;
  action: string;
  error?: ServerMessage;
  username?: string;
}

export function loginPage(opts: LoginPageOptions): string {
  const { locale, pending } = opts;
  const error = opts.error ? `<div class="box error" role="alert">${escape(translate(opts.error, locale))}</div>` : '';
  return layout(
    locale,
    `<h1>${t(locale, 'oauth.login.heading')}</h1>
<p class="muted">${t(locale, 'oauth.login.intro', { client: pending.client.name })}</p>${error}
<form method="post" action="${escape(opts.action)}">${hidden(pending)}
<label for="username">${t(locale, 'oauth.login.username')}</label><input id="username" name="username" autocomplete="username" required maxlength="256" value="${escape(opts.username ?? '')}" autofocus>
<label for="password">${t(locale, 'oauth.login.password')}</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024">
<div class="actions"><button class="primary" type="submit">${t(locale, 'oauth.login.submit')}</button></div></form>`,
  );
}

export interface ConsentPageOptions {
  locale: Locale;
  pending: PendingAuthorization;
  action: string;
}

export function consentPage(opts: ConsentPageOptions): string {
  const { locale, pending } = opts;
  const user = pending.user!;
  const { client, request } = pending;
  const identity =
    client.kind === 'cimd'
      ? `<p class="muted">${t(locale, 'oauth.consent.clientHost', { host: new URL(client.clientId).host })}</p>`
      : `<p class="muted">${t(locale, 'oauth.consent.clientUnverified')}</p>`;
  const redirectUrl = new URL(request.redirectUri);
  const local = isLoopbackRedirect(request.redirectUri) || (redirectUrl.protocol !== 'https:' && redirectUrl.protocol !== 'http:');
  const destination = local
    ? `<p class="muted">${t(locale, 'oauth.consent.redirectLocal')}</p>`
    : `<p class="muted">${t(locale, 'oauth.consent.redirectHost', { host: redirectUrl.host })}</p>`;
  const warnings = [
    local ? `<div class="box warn">${t(locale, 'oauth.consent.warnLoopback')}</div>` : '',
    client.kind === 'dcr' ? `<div class="box warn">${t(locale, 'oauth.consent.warnDcr')}</div>` : '',
  ].join('');
  const scopes = request.scopes
    .map((scope) => (scope === 'mcp' || scope === 'offline_access' ? `<li>${t(locale, `oauth.consent.scope.${scope}`)}</li>` : ''))
    .join('');
  return layout(
    locale,
    `<h1>${t(locale, 'oauth.consent.heading', { client: client.name })}</h1>
<p class="muted">${t(locale, 'oauth.consent.signedInAs', { user: user.username, tenant: user.tenantSlug })}</p>${identity}${destination}${warnings}
<p>${t(locale, 'oauth.consent.scopesHeading')}</p><ul>${scopes}</ul>
<p class="muted">${t(locale, 'oauth.consent.revokeHint')}</p>
<form method="post" action="${escape(opts.action)}">${hidden(pending)}
<div class="actions"><button type="submit" name="decision" value="deny">${t(locale, 'oauth.consent.deny')}</button><button class="primary" type="submit" name="decision" value="approve">${t(locale, 'oauth.consent.approve')}</button></div></form>`,
  );
}

export function errorPage(locale: Locale, message: ServerMessage): string {
  return layout(
    locale,
    `<h1>${t(locale, 'oauth.error.heading')}</h1><div class="box error" role="alert">${escape(translate(message, locale))}</div><p class="muted">${t(locale, 'oauth.error.close')}</p>`,
  );
}

import { hashPassword } from '@mcp-gateway/core';
import { s256Challenge } from '@mcp-gateway/oauth';
import type { Harness } from './harness';

/** Plays the browser part of the authorization code flow against a listening gateway (F20.6). */

export const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

export interface BrowserFlow {
  status: number;
  html: string;
  location: string | null;
  cookie?: string;
  requestId?: string;
  csrf?: string;
}

const hiddenField = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1];

export async function createPasswordUser(h: Harness, username: string, password: string, tenant: string | null, roles = ['agent']) {
  const tenantId = tenant ? (await h.services.repos.tenants.findBySlug(tenant))!.id : null;
  return h.services.repos.auth.createUser(tenantId, { username, passwordHash: await hashPassword(password), roles });
}

export async function startAuthorize(base: string, params: Record<string, string | undefined>): Promise<BrowserFlow> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, v);
  const res = await fetch(`${base}/oauth/authorize?${qs}`, { redirect: 'manual' });
  const html = await res.text();
  return {
    status: res.status,
    html,
    location: res.headers.get('location'),
    cookie: res.headers.get('set-cookie')?.split(';')[0],
    requestId: hiddenField(html, 'request_id'),
    csrf: hiddenField(html, 'csrf'),
  };
}

/**
 * Plays the browser for an authorization URL built by a client (e.g. the SDK's `auth()`):
 * opens it, signs in, approves and returns the code and `iss` from the redirect.
 */
export async function approveInBrowser(authorizationUrl: URL, username: string, password: string): Promise<{ code: string; iss: string | null; state: string | null }> {
  const base = authorizationUrl.origin;
  const res = await fetch(authorizationUrl, { redirect: 'manual' });
  const html = await res.text();
  if (res.status !== 200) throw new Error(`authorize answered ${res.status}: ${res.headers.get('location') ?? html.slice(0, 200)}`);
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  let step = await postForm(base, '/oauth/authorize/login', { request_id: hiddenField(html, 'request_id'), csrf: hiddenField(html, 'csrf'), username, password }, cookie);
  if (step.status === 200) step = await postForm(base, '/oauth/authorize/consent', { request_id: step.requestId, csrf: step.csrf, decision: 'approve' }, cookie);
  if (step.status !== 303 || !step.location) throw new Error(`flow ended with ${step.status}: ${step.html.slice(0, 200)}`);
  const url = new URL(step.location);
  const code = url.searchParams.get('code');
  if (!code) throw new Error(`no code in ${step.location}`);
  return { code, iss: url.searchParams.get('iss'), state: url.searchParams.get('state') };
}

export async function postForm(base: string, path: string, fields: Record<string, string | undefined>, cookie?: string): Promise<BrowserFlow> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) body.set(k, v);
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body,
  });
  const html = await res.text();
  return { status: res.status, html, location: res.headers.get('location'), requestId: hiddenField(html, 'request_id'), csrf: hiddenField(html, 'csrf') };
}

/**
 * Runs authorize → login → consent (when shown) and returns the code from the redirect.
 * Throws when the flow does not end in a redirect with a code.
 */
export async function authorizeCode(
  base: string,
  opts: { clientId: string; redirectUri: string; username: string; password: string; scope?: string; resource?: string; verifier?: string },
): Promise<string> {
  const flow = await startAuthorize(base, {
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    code_challenge: s256Challenge(opts.verifier ?? VERIFIER),
    code_challenge_method: 'S256',
    resource: opts.resource,
    scope: opts.scope ?? 'mcp offline_access',
    state: 'flow',
  });
  if (flow.status !== 200) throw new Error(`authorize answered ${flow.status}: ${flow.location ?? flow.html.slice(0, 200)}`);
  let step = await postForm(base, '/oauth/authorize/login', { request_id: flow.requestId, csrf: flow.csrf, username: opts.username, password: opts.password }, flow.cookie);
  if (step.status === 200) {
    step = await postForm(base, '/oauth/authorize/consent', { request_id: step.requestId, csrf: step.csrf, decision: 'approve' }, flow.cookie);
  }
  const code = step.location ? new URL(step.location).searchParams.get('code') : null;
  if (step.status !== 303 || !code) throw new Error(`flow ended with ${step.status}: ${step.location ?? step.html.slice(0, 200)}`);
  return code;
}

export async function tokenRequest(base: string, fields: Record<string, string | undefined>, path = '/oauth/token') {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) body.set(k, v);
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

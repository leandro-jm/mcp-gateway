import { hashPassword, hashToken } from '@mcp-gateway/core';
import { s256Challenge } from '@mcp-gateway/oauth';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ClientMetadataFetcher } from '../src/oauth/clients';
import { startHarness, type Harness } from './harness';
import { setTenantOAuth } from './oauth-helpers';

const PUBLIC_URL = 'http://gateway.test';
const CLAUDE = 'https://claude.ai/oauth/mcp-client-metadata';
const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

const documents: Record<string, unknown> = {
  [CLAUDE]: { client_id: CLAUDE, client_name: 'Claude', redirect_uris: [CLAUDE_REDIRECT] },
  'https://evil.example/meta': { client_id: 'https://evil.example/meta', client_name: '<script>alert(1)</script>', redirect_uris: ['http://127.0.0.1/cb'] },
};
let fetches = 0;
const fetcher: ClientMetadataFetcher = async (url) => {
  fetches++;
  if (!(url in documents)) throw new Error('404');
  return { json: documents[url] };
};

interface Flow {
  status: number;
  html: string;
  location: string | null;
  cookie?: string;
  requestId?: string;
  csrf?: string;
}

function hiddenField(html: string, name: string): string | undefined {
  return new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1];
}

describe('OAuth authorize, login and consent (F20.6, ADR-030)', () => {
  let h: Harness;
  let base: string;

  const authorizeParams = (over: Record<string, string | undefined> = {}) => {
    const params: Record<string, string | undefined> = {
      response_type: 'code',
      client_id: CLAUDE,
      redirect_uri: CLAUDE_REDIRECT,
      code_challenge: s256Challenge(VERIFIER),
      code_challenge_method: 'S256',
      resource: `${PUBLIC_URL}/mcp/omni`,
      scope: 'mcp offline_access',
      state: 'st-123',
      ...over,
    };
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, v);
    return qs.toString();
  };

  async function start(over: Record<string, string | undefined> = {}, headers: Record<string, string> = {}): Promise<Flow> {
    const res = await fetch(`${base}/oauth/authorize?${authorizeParams(over)}`, { redirect: 'manual', headers });
    const html = await res.text();
    const cookie = res.headers.get('set-cookie')?.split(';')[0];
    return { status: res.status, html, location: res.headers.get('location'), cookie, requestId: hiddenField(html, 'request_id'), csrf: hiddenField(html, 'csrf') };
  }

  async function post(path: string, fields: Record<string, string | undefined>, cookie?: string): Promise<Flow> {
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

  const login = (flow: Flow, username = 'maria', password = 'maria-pass') =>
    post('/oauth/authorize/login', { request_id: flow.requestId, csrf: flow.csrf, username, password }, flow.cookie);
  const consent = (flow: Flow, page: Flow, decision = 'approve') =>
    post('/oauth/authorize/consent', { request_id: page.requestId, csrf: page.csrf, decision }, flow.cookie);

  async function createUser(username: string, password: string, tenant: string | null, roles = ['agent']) {
    const tenantId = tenant ? (await h.services.repos.tenants.findBySlug(tenant))!.id : null;
    return h.services.repos.auth.createUser(tenantId, { username, passwordHash: await hashPassword(password), roles, locale: 'pt-BR' });
  }

  beforeAll(async () => {
    h = await startHarness({ env: { OAUTH_ENABLED: 'true' }, clientMetadataFetcher: fetcher });
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    await h.services.repos.tenants.create({ slug: 'acme', name: 'ACME' });
    await h.services.repos.tenants.create({ slug: 'closed', name: 'Closed' });
    await createUser('maria', 'maria-pass', 'acme');
    await createUser('joao', 'joao-pass', 'acme');
    await createUser('closed-user', 'closed-pass', 'closed');
    await createUser('platform', 'platform-pass', null, ['gateway-admin']);
  });
  afterAll(async () => h?.teardown());
  beforeEach(async () => {
    await setTenantOAuth(h, 'acme', { enabled: true, clients: 'allowlist', allowlist: ['claude.ai'] });
    await h.services.redis.del('rl:login:maria:127.0.0.1', 'rl:login-user:maria');
  });

  it('signs in, asks for consent and redirects with a single-use code bound to the request', async () => {
    const flow = await start();
    expect(flow.status).toBe(200);
    expect(flow.html).toContain('Claude');
    expect(flow.cookie).toMatch(/^mgw_oauth=/);
    expect(flow.requestId && flow.csrf).toBeTruthy();

    const page = await login(flow);
    expect(page.status).toBe(200);
    // consent in the user's language
    expect(page.html).toContain('Permitir que Claude acesse sua conta?');
    expect(page.html).toContain('claude.ai');

    const done = await consent(flow, page);
    expect(done.status).toBe(303);
    const url = new URL(done.location!);
    expect(`${url.origin}${url.pathname}`).toBe(CLAUDE_REDIRECT);
    expect(url.searchParams.get('state')).toBe('st-123');
    expect(url.searchParams.get('iss')).toBe(PUBLIC_URL);
    const code = url.searchParams.get('code')!;
    expect(code).toMatch(/^mgc_/);

    const redeemed = await h.services.repos.oauth.redeemCode(hashToken(code));
    expect(redeemed.status).toBe('ok');
    if (redeemed.status === 'ok') {
      expect(redeemed.value).toMatchObject({
        redirectUri: CLAUDE_REDIRECT,
        codeChallenge: s256Challenge(VERIFIER),
        resource: `${PUBLIC_URL}/mcp/omni`,
        scopes: ['mcp', 'offline_access'],
      });
      expect(redeemed.value.client.clientId).toBe(CLAUDE);
    }
    const audit = await h.services.repos.audit.list((await h.services.repos.tenants.findBySlug('acme'))!.id, { action: 'oauth.grant.approve' });
    expect(audit[0]).toMatchObject({ subject: 'maria', clientId: 'oauth:claude.ai', decision: 'allow' });
  });

  it('skips the consent screen when an active grant already covers the scopes', async () => {
    const flow = await start({ scope: 'mcp', state: 'again' });
    const done = await login(flow);
    expect(done.status).toBe(303);
    const url = new URL(done.location!);
    expect(url.searchParams.get('code')).toMatch(/^mgc_/);
    expect(url.searchParams.get('state')).toBe('again');
  });

  it('reuses a fetched metadata document while it is cached', async () => {
    const before = fetches;
    await start();
    await start();
    expect(fetches).toBe(before);
  });

  it('sends access_denied back when the user denies', async () => {
    const flow = await start();
    const page = await login(flow, 'joao', 'joao-pass');
    const done = await consent(flow, page, 'deny');
    const url = new URL(done.location!);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('st-123');
    expect(url.searchParams.get('iss')).toBe(PUBLIC_URL);
    expect(url.searchParams.has('code')).toBe(false);
  });

  it.each([
    ['no client_id', { client_id: undefined }, 'client_id parameter is required'],
    ['an unknown DCR client', { client_id: 'dcr_nope' }, 'client_id is not valid'],
    ['a metadata document that cannot be fetched', { client_id: 'https://down.example/meta' }, 'could not be retrieved'],
    ['a redirect URI the client did not register', { redirect_uri: 'https://attacker.example/cb' }, 'not registered for this client'],
  ] as const)('shows a page and never redirects for %s', async (_l, over, text) => {
    const flow = await start(over);
    expect(flow.status).toBe(400);
    expect(flow.location).toBeNull();
    expect(flow.html).toContain(text);
  });

  it.each([
    ['PKCE is missing', { code_challenge: undefined }, 'invalid_request'],
    ['PKCE is plain', { code_challenge_method: 'plain' }, 'invalid_request'],
    ['the response type is not code', { response_type: 'token' }, 'unsupported_response_type'],
    ['the resource is another server', { resource: 'https://other.example/mcp' }, 'invalid_target'],
  ] as const)('redirects the error to the client when %s', async (_l, over, error) => {
    const flow = await start(over);
    expect(flow.status).toBe(303);
    const url = new URL(flow.location!);
    expect(url.searchParams.get('error')).toBe(error);
    expect(url.searchParams.get('state')).toBe('st-123');
    expect(url.searchParams.get('iss')).toBe(PUBLIC_URL);
  });

  it('keeps the person on the login page after a wrong password', async () => {
    const flow = await start();
    const wrong = await login(flow, 'maria', 'nope');
    expect(wrong.status).toBe(401);
    expect(wrong.html).toContain('Invalid username or password.');
    // the same request goes on; maria already approved Claude, so the code comes right away
    const retry = await login(flow);
    expect(retry.status).toBe(303);
    expect(new URL(retry.location!).searchParams.get('code')).toMatch(/^mgc_/);
  });

  it.each([
    ['the tenant did not enable OAuth', 'closed-user', 'closed-pass', 'has not enabled app connections'],
    ['the account has no tenant', 'platform', 'platform-pass', 'this account cannot connect apps'],
  ] as const)('refuses on the login page when %s', async (_l, user, password, text) => {
    const flow = await start();
    const res = await login(flow, user, password);
    expect(res.status).toBe(403);
    expect(res.html).toContain(text);
  });

  it('refuses apps outside the tenant allowlist', async () => {
    await setTenantOAuth(h, 'acme', { enabled: true, clients: 'allowlist', allowlist: ['chatgpt.com'] });
    const res = await login(await start());
    expect(res.status).toBe(403);
    expect(res.html).toContain('does not allow this app');
  });

  it('binds the request to the browser and the form (CSRF)', async () => {
    const flow = await start();
    const other = await start();
    expect((await post('/oauth/authorize/login', { request_id: flow.requestId, csrf: 'forged', username: 'maria', password: 'maria-pass' }, flow.cookie)).status).toBe(400);
    expect((await post('/oauth/authorize/login', { request_id: flow.requestId, csrf: flow.csrf, username: 'maria', password: 'maria-pass' })).status).toBe(400);
    expect((await post('/oauth/authorize/login', { request_id: flow.requestId, csrf: flow.csrf, username: 'maria', password: 'maria-pass' }, other.cookie)).status).toBe(400);
  });

  it('issues one code even if the consent form is submitted twice', async () => {
    const flow = await start({ state: 'twice' });
    await createUser('ana', 'ana-pass', 'acme'); // no grant yet, so the consent page shows
    const page = await login(flow, 'ana', 'ana-pass');
    expect(page.status).toBe(200);
    const [a, b] = await Promise.all([consent(flow, page), consent(flow, page)]);
    expect([a.status, b.status].sort()).toEqual([303, 400]);
  });

  it('escapes self-declared names and sets protective headers', async () => {
    await setTenantOAuth(h, 'acme', { enabled: true, clients: 'any' });
    const res = await fetch(`${base}/oauth/authorize?${authorizeParams({ client_id: 'https://evil.example/meta', redirect_uri: 'http://127.0.0.1:5555/cb' })}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&#60;script&#62;');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('content-security-policy')).toContain("form-action 'self' http://127.0.0.1:5555");
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('follows Accept-Language before sign-in', async () => {
    const flow = await start({}, { 'accept-language': 'es' });
    expect(flow.html).toContain('Inicie sesión para continuar');
  });
});

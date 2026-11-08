import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ClientMetadataFetcher } from '../src/oauth/clients';
import { startHarness, type Harness } from './harness';
import { authorizeCode, createPasswordUser, tokenRequest, VERIFIER } from './oauth-flow';
import { setTenantOAuth } from './oauth-helpers';
import { seedRhTenant } from './seed';

const PUBLIC_URL = 'http://gateway.test';
const CLAUDE = 'https://claude.ai/oauth/mcp-client-metadata';
const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const OTHER = 'https://other.example/meta';

const documents: Record<string, unknown> = {
  [CLAUDE]: { client_id: CLAUDE, client_name: 'Claude', redirect_uris: [CLAUDE_REDIRECT] },
  [OTHER]: { client_id: OTHER, client_name: 'Other', redirect_uris: ['https://other.example/cb'] },
};
const fetcher: ClientMetadataFetcher = async (url) => {
  if (!(url in documents)) throw new Error('404');
  return { json: documents[url] };
};

describe('OAuth token, revocation and registration (F20.7, ADR-030)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let base: string;
  let users = 0;

  /** A fresh user goes through the consent screen, so every test starts from its own grant. */
  async function newUser(): Promise<{ username: string; password: string }> {
    const username = `user-${++users}`;
    await createPasswordUser(h, username, 'secret-pass', 'acme');
    return { username, password: 'secret-pass' };
  }

  async function codeFor(user: { username: string; password: string }, over: { scope?: string; clientId?: string; redirectUri?: string } = {}) {
    return authorizeCode(base, { clientId: CLAUDE, redirectUri: CLAUDE_REDIRECT, resource: `${PUBLIC_URL}/mcp`, ...user, ...over });
  }

  const exchange = (code: string, over: Record<string, string | undefined> = {}) =>
    tokenRequest(base, {
      grant_type: 'authorization_code',
      code,
      client_id: CLAUDE,
      redirect_uri: CLAUDE_REDIRECT,
      code_verifier: VERIFIER,
      resource: `${PUBLIC_URL}/mcp`,
      ...over,
    });
  const refresh = (refreshToken: string, over: Record<string, string | undefined> = {}) =>
    tokenRequest(base, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLAUDE, ...over });

  const listTools = (token: string) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

  beforeAll(async () => {
    h = await startHarness({ env: { OAUTH_ENABLED: 'true' }, clientMetadataFetcher: fetcher });
    up = await startFakeUpstream();
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    await seedRhTenant(h, up, { slug: 'acme' });
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
  });
  beforeEach(async () => setTenantOAuth(h, 'acme', { enabled: true, clients: 'allowlist', allowlist: ['claude.ai', 'other.example'] }));

  it('exchanges the code for tokens that reach the MCP tools', async () => {
    const res = await exchange(await codeFor(await newUser()));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp offline_access' });
    expect(res.body.access_token).toMatch(/^mgw_/);
    expect(res.body.refresh_token).toMatch(/^mgr_/);
    const tools = await listTools(res.body.access_token as string);
    expect(tools.status).toBe(200);
    expect(((await tools.json()) as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0);
  });

  it('gives no refresh token without offline_access', async () => {
    const res = await exchange(await codeFor(await newUser(), { scope: 'mcp' }));
    expect(res.body.scope).toBe('mcp');
    expect(res.body).not.toHaveProperty('refresh_token');
  });

  it('applies the shorter access lifetime of the tenant', async () => {
    await setTenantOAuth(h, 'acme', { enabled: true, clients: 'any', accessTtlMinutes: 5 });
    const res = await exchange(await codeFor(await newUser()));
    expect(res.body.expires_in).toBe(300);
  });

  it('revokes everything issued when a code is redeemed twice', async () => {
    const code = await codeFor(await newUser());
    const first = await exchange(code);
    expect(first.status).toBe(200);
    const second = await exchange(code);
    expect(second.status).toBe(400);
    expect(second.body).toMatchObject({ error: 'invalid_grant' });
    expect(second.body.error_description).toContain('already used');
    expect((await listTools(first.body.access_token as string)).status).toBe(401);
    expect((await refresh(first.body.refresh_token as string)).status).toBe(400);
  });

  it.each([
    ['a wrong PKCE verifier', { code_verifier: `${VERIFIER.slice(0, -1)}A` }, 'invalid_grant', 'does not match the code_challenge'],
    ['another client', { client_id: OTHER }, 'invalid_grant', 'issued to another client'],
    ['another redirect URI', { redirect_uri: 'https://claude.ai/other' }, 'invalid_grant', 'not registered'],
    ['another resource', { resource: `${PUBLIC_URL}/mcp/omni` }, 'invalid_target', 'does not match the one authorized'],
    ['an unknown code', { code: 'mgc_nope' }, 'invalid_grant', 'invalid or expired'],
  ] as const)('refuses a code exchange with %s', async (_l, over, error, text) => {
    const res = await exchange(await codeFor(await newUser()), over);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
    expect(res.body.error_description).toContain(text);
  });

  it('refuses malformed token requests in the RFC 6749 format', async () => {
    expect((await tokenRequest(base, { grant_type: 'client_credentials' })).body).toMatchObject({ error: 'unsupported_grant_type' });
    expect((await tokenRequest(base, { grant_type: 'authorization_code', client_id: CLAUDE })).body).toMatchObject({ error: 'invalid_request' });
  });

  it('rotates refresh tokens and revokes the grant when an old one comes back', async () => {
    const first = await exchange(await codeFor(await newUser()));
    const second = await refresh(first.body.refresh_token as string);
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).toMatch(/^mgr_/);
    expect(second.body.refresh_token).not.toBe(first.body.refresh_token);
    expect((await listTools(second.body.access_token as string)).status).toBe(200);

    const replay = await refresh(first.body.refresh_token as string);
    expect(replay.status).toBe(400);
    expect(replay.body.error_description).toContain('already used');
    expect((await listTools(second.body.access_token as string)).status).toBe(401);
    expect((await refresh(second.body.refresh_token as string)).status).toBe(400);
  });

  it('does not rotate a refresh token presented by another client', async () => {
    const first = await exchange(await codeFor(await newUser()));
    const stolen = await refresh(first.body.refresh_token as string, { client_id: OTHER });
    expect(stolen.body.error_description).toContain('issued to another client');
    expect((await refresh(first.body.refresh_token as string)).status).toBe(200);
  });

  it('stops refreshing when the tenant turns OAuth off', async () => {
    const first = await exchange(await codeFor(await newUser()));
    await setTenantOAuth(h, 'acme', { enabled: false });
    const res = await refresh(first.body.refresh_token as string);
    expect(res.status).toBe(400);
    expect(res.body.error_description).toContain('has not enabled app connections');
  });

  it('revokes the grant through its refresh token (RFC 7009) and answers 200 for unknown tokens', async () => {
    const first = await exchange(await codeFor(await newUser()));
    const revoked = await tokenRequest(base, { token: first.body.refresh_token as string, client_id: CLAUDE }, '/oauth/revoke');
    expect(revoked.status).toBe(200);
    expect((await listTools(first.body.access_token as string)).status).toBe(401);
    expect((await tokenRequest(base, { token: 'mgr_unknown', client_id: CLAUDE }, '/oauth/revoke')).status).toBe(200);
  });

  it('revokes a single access token only for its own client', async () => {
    const first = await exchange(await codeFor(await newUser()));
    await tokenRequest(base, { token: first.body.access_token as string, client_id: OTHER }, '/oauth/revoke');
    expect((await listTools(first.body.access_token as string)).status).toBe(200);
    await tokenRequest(base, { token: first.body.access_token as string, client_id: CLAUDE }, '/oauth/revoke');
    expect((await listTools(first.body.access_token as string)).status).toBe(401);
    expect((await refresh(first.body.refresh_token as string)).status).toBe(200);
  });

  it('registers a public client (RFC 7591) that can then complete the flow', async () => {
    await setTenantOAuth(h, 'acme', { enabled: true, clients: 'any' });
    const res = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: ['http://localhost:7777/callback'], token_endpoint_auth_method: 'client_secret_post' }),
    });
    expect(res.status).toBe(201);
    const client = (await res.json()) as Record<string, unknown>;
    expect(client).toMatchObject({ client_name: 'Claude Code', token_endpoint_auth_method: 'none', application_type: 'native' });
    expect(client.client_id).toMatch(/^dcr_/);
    expect(client).not.toHaveProperty('client_secret');

    const redirectUri = 'http://localhost:51515/callback';
    const code = await authorizeCode(base, { clientId: client.client_id as string, redirectUri, ...(await newUser()) });
    const tokens = await tokenRequest(base, {
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id as string,
      redirect_uri: redirectUri,
      code_verifier: VERIFIER,
    });
    expect(tokens.status).toBe(200);
    expect((await listTools(tokens.body.access_token as string)).status).toBe(200);
  });

  it('refuses invalid registrations with RFC 7591 errors', async () => {
    const res = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://attacker.example/cb'] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_redirect_uri' });
  });

  it('answers CORS preflights of the token endpoints', async () => {
    for (const path of ['/oauth/token', '/oauth/revoke', '/oauth/register']) {
      const res = await fetch(`${base}${path}`, { method: 'OPTIONS' });
      expect(res.status, path).toBe(204);
      expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    }
  });
});

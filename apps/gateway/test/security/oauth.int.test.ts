import { hashToken, REFRESH_TOKEN_PREFIX } from '@mcp-gateway/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../harness';
import { authorizeCode, createPasswordUser, startAuthorize, tokenRequest, VERIFIER } from '../oauth-flow';
import { setTenantOAuth } from '../oauth-helpers';

const REDIRECT = 'http://127.0.0.1:7777/callback';

/**
 * Threats T14–T18 of ADR-003 (ADR-030) against the real authorization server: the CIMD fetcher is
 * the production one and private networks are blocked, as in production.
 */
describe('security: OAuth authorization server (ADR-003 T14–T18)', () => {
  let h: Harness;
  let base: string;
  let clientId: string;
  let users = 0;

  async function newUser() {
    const username = `sec-${++users}`;
    await createPasswordUser(h, username, 'sec-password', 'acme');
    return { username, password: 'sec-password' };
  }
  const codeFor = async (scope = 'mcp offline_access') => authorizeCode(base, { clientId, redirectUri: REDIRECT, scope, ...(await newUser()) });
  const exchange = (code: string, over: Record<string, string | undefined> = {}) =>
    tokenRequest(base, { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER, ...over });
  const rpc = (token: string) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

  beforeAll(async () => {
    h = await startHarness({ env: { OAUTH_ENABLED: 'true', NETWORK_ALLOW_PRIVATE: 'false' } });
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    await h.services.repos.tenants.create({ slug: 'acme', name: 'ACME' });
    await setTenantOAuth(h, 'acme', { enabled: true, clients: 'any' });
    const reg = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT] }),
    });
    clientId = ((await reg.json()) as { client_id: string }).client_id;
  });
  afterAll(async () => h?.teardown());

  describe('T14: code theft and replay', () => {
    it('a stolen code is useless without the PKCE verifier', async () => {
      const res = await exchange(await codeFor(), { code_verifier: 'x'.repeat(43) });
      expect(res.body).toMatchObject({ error: 'invalid_grant' });
    });

    it('a replayed code revokes what the first redemption issued', async () => {
      const code = await codeFor();
      const first = await exchange(code);
      expect((await rpc(first.body.access_token as string)).status).toBe(200);
      expect((await exchange(code)).body).toMatchObject({ error: 'invalid_grant' });
      expect((await rpc(first.body.access_token as string)).status).toBe(401);
    });

    it('an expired code is refused', async () => {
      const code = await codeFor();
      await h.services.dbHandle.pool.query("UPDATE oauth_authorization_codes SET expires_at = now() - interval '1 second' WHERE code_hash = $1", [hashToken(code)]);
      expect((await exchange(code)).body).toMatchObject({ error: 'invalid_grant' });
    });

    it('codes are stored only as hashes', async () => {
      const code = await codeFor();
      const { rows } = await h.services.dbHandle.pool.query('SELECT code_hash FROM oauth_authorization_codes');
      expect(JSON.stringify(rows)).not.toContain(code);
    });
  });

  describe('T15: open redirect and code leakage', () => {
    it.each([
      ['an unregistered host', 'https://attacker.example/callback'],
      ['another path on loopback', 'http://127.0.0.1:7777/other'],
      ['another scheme on loopback', 'https://127.0.0.1:7777/callback'],
    ])('never redirects to %s', async (_l, redirectUri) => {
      const flow = await startAuthorize(base, { response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256' });
      expect(flow.status).toBe(400);
      expect(flow.location).toBeNull();
    });

    it('accepts another port only on loopback, as native apps need', async () => {
      const flow = await startAuthorize(base, {
        response_type: 'code',
        client_id: clientId,
        redirect_uri: 'http://127.0.0.1:51000/callback',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
      });
      expect(flow.status).toBe(200);
    });

    it('pages send no referrer and are not cached', async () => {
      const res = await fetch(`${base}/oauth/authorize?client_id=${clientId}`);
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('cache-control')).toBe('no-store');
    });
  });

  describe('T16: confused deputy and deceptive consent', () => {
    it('a self-declared name never becomes the policy identity', async () => {
      const first = await exchange(await codeFor());
      const principal = await h.services.verifier.verify(first.body.access_token as string);
      expect(principal.clientId).toBe(`oauth:dcr:${clientId}`);
    });

    it('the consent page cannot be framed and is flagged as unverified', async () => {
      const flow = await startAuthorize(base, { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256' });
      expect(flow.status).toBe(200);
      const res = await fetch(`${base}/oauth/authorize/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: flow.cookie! },
        body: new URLSearchParams({ request_id: flow.requestId!, csrf: flow.csrf!, ...(await newUser()) }),
      });
      const html = await res.text();
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(html).toContain('registered itself');
      expect(html).toContain('program on this computer');
    });

    it('a login form posted from another browser session is refused', async () => {
      const flow = await startAuthorize(base, { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256' });
      const res = await fetch(`${base}/oauth/authorize/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ request_id: flow.requestId!, csrf: flow.csrf!, ...(await newUser()) }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('T17: SSRF through client metadata documents', () => {
    it.each([
      ['a loopback IP', 'https://127.0.0.1/meta.json'],
      ['localhost', 'https://localhost/meta.json'],
      ['cloud metadata', 'https://169.254.169.254/latest/meta-data'],
      ['a private network', 'https://10.0.0.5/meta.json'],
    ])('never fetches a document on %s', async (_l, url) => {
      const flow = await startAuthorize(base, { response_type: 'code', client_id: url, redirect_uri: REDIRECT });
      expect(flow.status).toBe(400);
      expect(flow.html).toContain('could not be retrieved');
      expect(await h.services.repos.oauth.findClient(url)).toBeUndefined();
    });

    it('rejects client ids that are not canonical HTTPS URLs before any fetch', async () => {
      for (const url of ['http://example.com/meta', 'https://example.com', 'https://example.com/a/../meta']) {
        const flow = await startAuthorize(base, { response_type: 'code', client_id: url, redirect_uri: REDIRECT });
        expect(flow.status, url).toBe(400);
        expect(flow.html, url).toContain('client_id is not valid');
      }
    });
  });

  describe('T18: stolen or reused tokens', () => {
    it('a replayed refresh token revokes the whole grant', async () => {
      const first = await exchange(await codeFor());
      const second = await tokenRequest(base, { grant_type: 'refresh_token', refresh_token: first.body.refresh_token as string, client_id: clientId });
      expect(second.status).toBe(200);
      const replay = await tokenRequest(base, { grant_type: 'refresh_token', refresh_token: first.body.refresh_token as string, client_id: clientId });
      expect(replay.body).toMatchObject({ error: 'invalid_grant' });
      expect((await rpc(second.body.access_token as string)).status).toBe(401);
    });

    it('access tokens expire and never administer anything', async () => {
      const first = await exchange(await codeFor('mcp'));
      const admin = await fetch(`${base}/admin/v1/me`, { headers: { authorization: `Bearer ${first.body.access_token as string}` } });
      expect(admin.status).toBe(401);
      await h.services.dbHandle.pool.query("UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [
        hashToken(first.body.access_token as string),
      ]);
      h.services.verifier.clear();
      expect((await rpc(first.body.access_token as string)).status).toBe(401);
    });

    it('refresh tokens and access tokens are stored only as hashes', async () => {
      const first = await exchange(await codeFor());
      const refresh = first.body.refresh_token as string;
      expect(refresh.startsWith(REFRESH_TOKEN_PREFIX)).toBe(true);
      const dump = JSON.stringify((await h.services.dbHandle.pool.query('SELECT * FROM oauth_refresh_tokens')).rows);
      expect(dump).not.toContain(refresh);
      const tokens = JSON.stringify((await h.services.dbHandle.pool.query("SELECT * FROM api_tokens WHERE kind = 'oauth'")).rows);
      expect(tokens).not.toContain(first.body.access_token as string);
    });

    it('a disabled person loses every app at once', async () => {
      const user = await newUser();
      const code = await authorizeCode(base, { clientId, redirectUri: REDIRECT, ...user });
      const first = await exchange(code);
      const row = await h.services.repos.auth.findUser(user.username);
      await h.services.repos.users.update(row!.tenantId!, row!.id, { status: 'disabled' });
      h.services.verifier.clear();
      expect((await rpc(first.body.access_token as string)).status).toBe(401);
      expect((await tokenRequest(base, { grant_type: 'refresh_token', refresh_token: first.body.refresh_token as string, client_id: clientId })).body).toMatchObject({
        error: 'invalid_grant',
      });
    });
  });
});

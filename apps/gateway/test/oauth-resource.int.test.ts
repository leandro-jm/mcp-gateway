import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, startInfra, type Harness, type Infra } from './harness';
import { mintOAuthToken, setTenantOAuth } from './oauth-helpers';
import { seedRhTenant } from './seed';

const PUBLIC_URL = 'http://gateway.test';

async function rpc(base: string, path: string, token?: string, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

describe('OAuth resource server (F20.5, ADR-030)', () => {
  let infra: Infra;
  let up: FakeUpstream;

  beforeAll(async () => {
    infra = await startInfra();
    up = await startFakeUpstream();
  });
  afterAll(async () => {
    await up?.close();
    await infra?.stop();
  });

  describe('with OAUTH_ENABLED=false (default)', () => {
    let h: Harness;
    let base: string;

    beforeAll(async () => {
      h = await startHarness({ infra });
      base = await h.app.listen({ port: 0, host: '127.0.0.1' });
      await seedRhTenant(h, up, { slug: 'off' });
    });
    afterAll(async () => h?.teardown());

    it('serves no discovery document', async () => {
      for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
        expect((await fetch(`${base}${path}`)).status, path).toBe(404);
      }
    });

    it('keeps the challenge exactly as before', async () => {
      const res = await rpc(base, '/mcp/omni');
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer realm="mcp-gateway"');
    });

    it('rejects OAuth tokens left over from when it was on', async () => {
      await setTenantOAuth(h, 'off', { enabled: true, clients: 'any' });
      const { token } = await mintOAuthToken(h, { sub: 'off-user', tenant: 'off' });
      const res = await rpc(base, '/mcp', token);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain('disabled on this gateway');
    });
  });

  describe('with OAUTH_ENABLED=true', () => {
    let h: Harness;
    let base: string;

    beforeAll(async () => {
      h = await startHarness({ infra, env: { OAUTH_ENABLED: 'true' } });
      base = await h.app.listen({ port: 0, host: '127.0.0.1' });
      await seedRhTenant(h, up, { slug: 'acme' });
      await setTenantOAuth(h, 'acme', { enabled: true, clients: 'allowlist', allowlist: ['claude.ai', 'dcr_test-client'] });
    });
    afterAll(async () => h?.teardown());

    it('publishes the authorization server metadata (RFC 8414)', async () => {
      const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(await res.json()).toMatchObject({
        issuer: PUBLIC_URL,
        authorization_endpoint: `${PUBLIC_URL}/oauth/authorize`,
        token_endpoint: `${PUBLIC_URL}/oauth/token`,
        registration_endpoint: `${PUBLIC_URL}/oauth/register`,
        code_challenge_methods_supported: ['S256'],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
      });
    });

    it('publishes protected resource metadata for the gateway and each MCP surface (RFC 9728)', async () => {
      const cases: Array<[string, string]> = [
        ['/.well-known/oauth-protected-resource', PUBLIC_URL],
        ['/.well-known/oauth-protected-resource/mcp', `${PUBLIC_URL}/mcp`],
        ['/.well-known/oauth-protected-resource/mcp/omni', `${PUBLIC_URL}/mcp/omni`],
        ['/.well-known/oauth-protected-resource/mcp/s/rh-tools/omni', `${PUBLIC_URL}/mcp/s/rh-tools/omni`],
      ];
      for (const [path, resource] of cases) {
        const res = await fetch(`${base}${path}`);
        expect(res.status, path).toBe(200);
        expect(await res.json()).toEqual({
          resource,
          authorization_servers: [PUBLIC_URL],
          scopes_supported: ['mcp', 'offline_access'],
          bearer_methods_supported: ['header'],
          resource_name: 'MCP Gateway',
        });
      }
      expect((await fetch(`${base}/.well-known/oauth-protected-resource/admin/v1`)).status).toBe(404);
      const preflight = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`, { method: 'OPTIONS' });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-headers')).toContain('mcp-protocol-version');
    });

    it('points the 401 challenge at the metadata of the surface called', async () => {
      const omni = await rpc(base, '/mcp/omni');
      expect(omni.status).toBe(401);
      expect(omni.headers.get('www-authenticate')).toBe(
        `Bearer realm="mcp-gateway", resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp/omni", scope="mcp"`,
      );
      const invalid = await rpc(base, '/mcp', 'mgw_unknown');
      expect(invalid.headers.get('www-authenticate')).toMatch(
        /^Bearer realm="mcp-gateway", resource_metadata="http:\/\/gateway\.test\/\.well-known\/oauth-protected-resource\/mcp", scope="mcp", error="invalid_token"/,
      );
    });

    it('accepts an OAuth token of an allowed app on the data plane', async () => {
      const { token } = await mintOAuthToken(h, { sub: 'alice', tenant: 'acme' });
      const res = await rpc(base, '/mcp', token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: { tools: unknown[] } };
      expect(body.result.tools.length).toBeGreaterThan(0);
    });

    it('rejects OAuth tokens on the Admin API', async () => {
      const { token } = await mintOAuthToken(h, { sub: 'alice-admin', tenant: 'acme', roles: ['gateway-admin'] });
      const res = await fetch(`${base}/admin/v1/me`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { message: string }).message).toContain('only work on the MCP endpoints');
    });

    it('stops accepting the token when the grant is revoked', async () => {
      const { token, grantId } = await mintOAuthToken(h, { sub: 'bob', tenant: 'acme', clientId: 'dcr_test-client', kind: 'dcr' });
      expect((await rpc(base, '/mcp', token)).status).toBe(200);
      h.services.verifier.forget(...(await h.services.repos.oauth.revokeGrant(grantId)));
      const res = await rpc(base, '/mcp', token);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
    });

    it('stops accepting tokens of apps the tenant no longer allows', async () => {
      const { token } = await mintOAuthToken(h, { sub: 'carol', tenant: 'acme', clientId: 'https://chatgpt.com/oauth/meta' });
      const res = await rpc(base, '/mcp', token);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain('does not allow this app');
    });

    it('stops accepting every OAuth token when the tenant turns it off, but keeps static tokens', async () => {
      const { token } = await mintOAuthToken(h, { sub: 'dave', tenant: 'acme' });
      const staticToken = await h.token({ tenant: 'acme', sub: 'static-agent' });
      await setTenantOAuth(h, 'acme', { enabled: false });
      expect((await rpc(base, '/mcp', token)).status).toBe(401);
      expect((await rpc(base, '/mcp', staticToken)).status).toBe(200);
      await setTenantOAuth(h, 'acme', { enabled: true, clients: 'allowlist', allowlist: ['claude.ai', 'dcr_test-client'] });
    });
  });
});

import { createServer } from 'node:net';
import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import {
  auth,
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernTransport,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { auth as legacyAuth, type OAuthClientProvider as LegacyProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClientMetadataFetcher } from '../src/oauth/clients';
import { startHarness, type Harness } from './harness';
import { approveInBrowser, createPasswordUser } from './oauth-flow';
import { setTenantOAuth } from './oauth-helpers';
import { seedRhTenant } from './seed';

const REDIRECT = 'http://127.0.0.1:7777/callback';
const CIMD_URL = 'https://e2e-client.example/oauth/client.json';

const metadata: OAuthClientMetadata = {
  client_name: 'E2E agent',
  redirect_uris: [REDIRECT],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  scope: 'mcp offline_access',
};

const fetcher: ClientMetadataFetcher = async (url) => {
  if (url !== CIMD_URL) throw new Error('404');
  return { json: { client_id: CIMD_URL, ...metadata } };
};

/** In-memory client of the official SDK v2: stores what the SDK asks and records the redirect. */
class MemoryProvider implements OAuthClientProvider {
  info?: StoredOAuthClientInformation;
  stored?: StoredOAuthTokens;
  verifier = '';
  authorizationUrl?: URL;

  constructor(readonly clientMetadataUrl?: string) {}

  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata() {
    return metadata;
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: StoredOAuthClientInformation) {
    this.info = info;
  }
  tokens() {
    return this.stored;
  }
  saveTokens(tokens: StoredOAuthTokens) {
    this.stored = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

/** The same for the SDK 1.x client (2025 clients). */
class LegacyMemoryProvider implements LegacyProvider {
  info?: OAuthClientInformationFull;
  stored?: OAuthTokens;
  verifier = '';
  authorizationUrl?: URL;
  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata() {
    return metadata;
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationFull) {
    this.info = info;
  }
  tokens() {
    return this.stored;
  }
  saveTokens(tokens: OAuthTokens) {
    this.stored = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/**
 * End to end with the official SDK clients (F20.10): discovery from the 401, registration (CIMD
 * or DCR), PKCE, the browser step, the token exchange, tool calls and refresh. PUBLIC_URL is the
 * real listening address, so the SDK follows the gateway's own metadata.
 */
describe('OAuth end to end with the official SDK clients (F20.10, ADR-030)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let base: string;

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    h = await startHarness({ env: { OAUTH_ENABLED: 'true', PUBLIC_URL: base }, clientMetadataFetcher: fetcher });
    up = await startFakeUpstream();
    await h.app.listen({ port, host: '127.0.0.1' });
    await seedRhTenant(h, up, { slug: 'acme' });
    await setTenantOAuth(h, 'acme', { enabled: true, clients: 'any' });
    await createPasswordUser(h, 'e2e-modern', 'modern-pass', 'acme');
    await createPasswordUser(h, 'e2e-dcr', 'dcr-pass', 'acme');
    await createPasswordUser(h, 'e2e-legacy', 'legacy-pass', 'acme');
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
  });

  async function modernTools(serverUrl: string, provider: MemoryProvider) {
    const client = new ModernClient({ name: 'e2e', version: '1.0.0' });
    await client.connect(new ModernTransport(new URL(serverUrl), { authProvider: provider }));
    try {
      return (await client.listTools()).tools;
    } finally {
      await client.close();
    }
  }

  it('SDK v2 with a Client ID Metadata Document: discovery, consent, tools and refresh', async () => {
    const serverUrl = `${base}/mcp/omni`;
    const provider = new MemoryProvider(CIMD_URL);

    expect(await auth(provider, { serverUrl })).toBe('REDIRECT');
    const authorizationUrl = provider.authorizationUrl!;
    expect(authorizationUrl.origin).toBe(base);
    expect(authorizationUrl.searchParams.get('client_id')).toBe(CIMD_URL);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('resource')).toBe(serverUrl);

    const { code, iss } = await approveInBrowser(authorizationUrl, 'e2e-modern', 'modern-pass');
    expect(iss).toBe(base);
    expect(await auth(provider, { serverUrl, authorizationCode: code, iss: iss! })).toBe('AUTHORIZED');
    expect(provider.stored?.refresh_token).toMatch(/^mgr_/);

    const tools = await modernTools(serverUrl, provider);
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['search_tools', 'call_tool']));

    // the refresh grant rotates the tokens and keeps the client working
    const first = provider.stored!;
    provider.stored = { ...first, access_token: 'mgw_expired-on-purpose' };
    expect(await modernTools(serverUrl, provider)).toHaveLength(tools.length);
    expect(provider.stored?.access_token).not.toBe('mgw_expired-on-purpose');
    expect(provider.stored?.refresh_token).not.toBe(first.refresh_token);

    const grants = await h.services.repos.oauthGrants.list((await h.services.repos.tenants.findBySlug('acme'))!.id);
    expect(grants.items.find((g) => g.username === 'e2e-modern')).toMatchObject({ clientId: CIMD_URL, clientKind: 'cimd' });
  });

  it('SDK v2 with dynamic registration when the app has no metadata document', async () => {
    const serverUrl = `${base}/mcp`;
    const provider = new MemoryProvider();
    expect(await auth(provider, { serverUrl })).toBe('REDIRECT');
    expect(provider.info?.client_id).toMatch(/^dcr_/);
    const { code, iss } = await approveInBrowser(provider.authorizationUrl!, 'e2e-dcr', 'dcr-pass');
    expect(await auth(provider, { serverUrl, authorizationCode: code, iss: iss! })).toBe('AUTHORIZED');
    expect((await modernTools(serverUrl, provider)).length).toBeGreaterThan(0);
  });

  it('SDK 1.x (2025 clients) completes the same flow', async () => {
    const serverUrl = `${base}/mcp`;
    const provider = new LegacyMemoryProvider();
    expect(await legacyAuth(provider, { serverUrl })).toBe('REDIRECT');
    const { code } = await approveInBrowser(provider.authorizationUrl!, 'e2e-legacy', 'legacy-pass');
    expect(await legacyAuth(provider, { serverUrl, authorizationCode: code })).toBe('AUTHORIZED');

    const client = new LegacyClient({ name: 'e2e-legacy', version: '1.0.0' });
    await client.connect(new LegacyTransport(new URL(serverUrl), { authProvider: provider }));
    try {
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it('counts the flow in the OAuth metrics', async () => {
    const body = await h.services.metrics.registry.metrics();
    expect(body).toMatch(/mcp_oauth_authorizations_total\{outcome="code_issued"\} [1-9]/);
    expect(body).toMatch(/mcp_oauth_tokens_issued_total\{grant_type="authorization_code"\} [1-9]/);
    expect(body).toMatch(/mcp_oauth_tokens_issued_total\{grant_type="refresh_token"\} [1-9]/);
    expect(body).toMatch(/mcp_oauth_client_metadata_fetch_duration_seconds_count\{outcome="ok"\} [1-9]/);
  });
});

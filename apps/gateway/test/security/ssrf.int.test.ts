import { guardedConnector, guardedLookup, OutboundBlocked, outboundFetch } from '@mcp-gateway/net';
import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorPayload } from '../../src/proxy/result';
import { startHarness, type Harness } from '../harness';
import { mcpClient, seedRhTenant } from '../seed';

/** SSRF: production (NETWORK_ALLOW_PRIVATE=false) blocks private networks and honors the tenant allowlist. */
describe('security: SSRF', () => {
  let h: Harness;
  let up: FakeUpstream;
  let admin: string;

  const call = (method: string, url: string, body?: unknown) =>
    h.app.inject({ method: method as 'GET', url: `/admin/v1${url}`, headers: { authorization: `Bearer ${admin}`, 'x-tenant': 'acme' }, ...(body ? { payload: body as object } : {}) });

  beforeAll(async () => {
    h = await startHarness({ env: { NETWORK_ALLOW_PRIVATE: 'false' } });
    up = await startFakeUpstream();
    admin = await h.adminToken('acme');
    await h.services.repos.tenants.create({ slug: 'acme', name: 'ACME' });
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
  });

  it.each([
    ['http://127.0.0.1:4010', 'loopback'],
    ['http://169.254.169.254/latest/meta-data', 'cloud metadata'],
    ['http://10.0.0.5', 'private network'],
    ['http://[::1]:80', 'IPv6 loopback'],
    ['http://[::ffff:127.0.0.1]:4010', 'IPv4-mapped loopback'],
    ['http://[::ffff:169.254.169.254]/latest/meta-data', 'IPv4-mapped cloud metadata'],
    ['http://[64:ff9b::a9fe:a9fe]/', 'NAT64 cloud metadata'],
    ['http://localhost:4010', 'localhost'],
    ['file:///etc/passwd', 'file protocol'],
    ['http://user:secret@api.empresa.com', 'credential in the URL'],
  ])('rejects a source with base URL %s (%s)', async (baseUrl) => {
    const r = await call('POST', '/sources', { name: 'x', openapiUrl: 'https://api.empresa.com/openapi.json', baseUrl });
    expect(r.statusCode).toBe(400);
    // non-http(s) schemes are already rejected by the request schema, before the network policy
    if (baseUrl.startsWith('file:')) expect(r.json()).toMatchObject({ error: 'VALIDATION_ERROR', details: [{ path: '/baseUrl' }] });
    else expect(r.json()).toMatchObject({ error: 'VALIDATION_ERROR', message: expect.stringMatching(/^URL not allowed: /), details: { url: baseUrl } });
  });

  it("rejects a spec at an internal address and applies the tenant's allowlist", async () => {
    expect((await call('POST', '/sources', { name: 'a', openapiUrl: 'http://169.254.169.254/openapi.json', baseUrl: 'https://api.empresa.com' })).statusCode).toBe(400);
    const t = (await call('GET', '/tenants')).json().items[0];
    await call('PATCH', `/tenants/${t.id}`, { settings: { network: { allowedHosts: ['*.empresa.com.br'] } } });
    expect((await call('POST', '/sources', { name: 'b', openapiUrl: 'https://evil.com/openapi.json', baseUrl: 'https://evil.com' })).statusCode).toBe(400);
    expect((await call('POST', '/sources', { name: 'c', openapiUrl: 'https://rh.empresa.com.br/openapi.json', baseUrl: 'https://rh.empresa.com.br' })).statusCode).toBe(201);
  });

  it('import (ADR-014): URL inputs and base URLs follow the same policy', async () => {
    const preview = await call('POST', '/sources/import/preview', { input: { kind: 'url', url: 'http://169.254.169.254/collection.json' } });
    expect(preview.statusCode).toBe(400);
    expect(preview.json().message).toMatch(/^URL not allowed: /);
    const created = await call('POST', '/sources/import', {
      input: { kind: 'text', text: 'curl https://rh.empresa.com.br/escalas' },
      target: { kind: 'new', name: 'imported', baseUrl: 'http://10.0.0.5' },
    });
    expect(created.statusCode).toBe(400);
    expect(created.json().message).toMatch(/^URL not allowed: /);
  });

  it('blocks at call time even if the URL reached the database another way', async () => {
    const seeded = await seedRhTenant(h, up, { slug: 'internal', credential: 'apikey' }); // straight to the repo, no API validation
    const client = await mcpClient(await h.app.listen({ port: 0, host: '127.0.0.1' }), await h.token({ tenant: 'internal' }));
    try {
      const before = up.requests.length;
      const r = await client.callTool({ name: 'rh_escalas_list', arguments: {} });
      expect(errorPayload(r)).toMatchObject({ error: 'UPSTREAM_ERROR', details: { code: 'SSRF_BLOCKED' } });
      expect(up.requests.length).toBe(before); // never reached the upstream
    } finally {
      await client.close();
    }
    void seeded;
  });

  it('the connection lookup rejects names resolving to a private IP (anti DNS rebinding)', async () => {
    const lookup = guardedLookup(false);
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => lookup('localhost', {}, (e) => resolve(e)));
    expect(err?.code).toBe('EBLOCKED');
    // with the policy allowing it, the same name resolves
    const ok = await new Promise<NodeJS.ErrnoException | null>((resolve) => guardedLookup(true)('localhost', {}, (e) => resolve(e)));
    expect(ok).toBeNull();
    await expect(outboundFetch('http://127.0.0.1:1/', {}, { allowPrivate: false, allowedHosts: [] })).rejects.toThrow(/private/);
  });

  it('the connector rejects private IP literals, which never go through lookup', async () => {
    const connect = guardedConnector(false);
    const err = await new Promise<Error | null>((resolve) =>
      connect({ hostname: '[::ffff:7f00:1]', protocol: 'http:', port: new URL(up.url).port } as Parameters<typeof connect>[0], (...args) => resolve(args[0])),
    );
    expect(err).toBeInstanceOf(OutboundBlocked);
    const before = up.requests.length;
    await expect(outboundFetch(`http://[::ffff:127.0.0.1]:${new URL(up.url).port}/`, {}, { allowPrivate: false, allowedHosts: [] })).rejects.toThrow(/private/);
    expect(up.requests.length).toBe(before);
  });
});

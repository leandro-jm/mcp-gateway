import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { errorPayload } from '../src/proxy/result';
import { startHarness, startInfra, type Harness, type Infra } from './harness';
import { mcpClient, seedRhTenant, type SeededTenant } from './seed';

describe('credential manager (F3.3)', () => {
  let infra: Infra;
  let a: Harness;
  let b: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let clientA: Client;
  let clientB: Client;

  beforeAll(async () => {
    infra = await startInfra();
    const env = { GATEWAY_MASTER_KEY: Buffer.alloc(32, 3).toString('base64') };
    a = await startHarness({ infra, env });
    b = await startHarness({ infra, env });
    up = await startFakeUpstream({ tokenDelayMs: 150, tokenTtlSeconds: 3600 });
    seeded = await seedRhTenant(a, up);
    const token = await a.token({ tenant: 'acme' });
    clientA = await mcpClient(await a.app.listen({ port: 0, host: '127.0.0.1' }), token);
    clientB = await mcpClient(await b.app.listen({ port: 0, host: '127.0.0.1' }), token);
  });
  afterAll(async () => {
    await clientA?.close();
    await clientB?.close();
    await a?.teardown();
    await b?.teardown();
    await up?.close();
    await infra?.stop();
  });

  it('50 concurrent calls (on 2 replicas) produce a single token request', async () => {
    const calls = Array.from({ length: 50 }, (_, i) =>
      (i % 2 ? clientA : clientB).callTool({ name: 'rh_escalas_list', arguments: {} }),
    );
    const results = await Promise.all(calls);
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(up.tokenRequests()).toBe(1);
  });

  it('the token is never stored in clear text in Redis', async () => {
    const keys = await a.services.redis.keys('cred:token:*');
    expect(keys).toHaveLength(1);
    const raw = (await a.services.redis.get(keys[0]!))!;
    expect(raw).not.toContain('fake_');
    expect(raw.startsWith('v1.')).toBe(true);
  });

  it('a token expired/revoked on the upstream is renewed transparently', async () => {
    const before = up.tokenRequests();
    up.revokeTokens();
    const r = await clientA.callTool({ name: 'rh_escalas_list', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(up.tokenRequests()).toBe(before + 1);
    // the other replica reuses the new token from Redis (after dropping the local one on the 401)
    const r2 = await clientB.callTool({ name: 'rh_escalas_list', arguments: {} });
    expect(r2.isError).toBeFalsy();
    expect(up.tokenRequests()).toBe(before + 1);
  });

  it('credential rotation invalidates the cached token', async () => {
    const before = up.tokenRequests();
    await a.services.repos.credentials.update(seeded.tenantId, seeded.credentialId!, {
      config: { tokenUrl: `${up.url}/oauth/token`, clientId: 'gateway-client', clientSecret: 'gateway-secret', scope: 'rh' },
    });
    await a.services.registry.invalidate(seeded.tenantId);
    await new Promise((r) => setTimeout(r, 100));
    expect((await clientB.callTool({ name: 'rh_escalas_list', arguments: {} })).isError).toBeFalsy();
    expect(up.tokenRequests()).toBe(before + 1);
  });
});

describe('traffic guards (F3.4)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let client: Client;

  const setSettings = async (settings: Record<string, unknown>) => {
    await h.services.repos.tenants.update(seeded.tenantId, { settings });
    await h.services.registry.invalidate(seeded.tenantId);
  };

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream({ colaboradores: 400 });
    seeded = await seedRhTenant(h, up, { credential: 'apikey', sourceSettings: { maxRetries: 0 } });
    client = await mcpClient(await h.app.listen({ port: 0, host: '127.0.0.1' }), await h.token({ tenant: 'acme', azp: 'cli-1' }));
  });
  beforeEach(async () => {
    await h.services.redis.eval("for _,k in ipairs(redis.call('keys','rl:*')) do redis.call('del',k) end", 0);
  });
  afterAll(async () => {
    await client?.close();
    await h?.teardown();
    await up?.close();
  });

  it('per-tool rate limit (with an override by name)', async () => {
    await setSettings({ rateLimits: { tools: { rh_escalas_list: { limit: 2, windowSec: 60 } } } });
    for (let i = 0; i < 2; i++) expect((await client.callTool({ name: 'rh_escalas_list', arguments: {} })).isError).toBeFalsy();
    const r = await client.callTool({ name: 'rh_escalas_list', arguments: {} });
    expect(errorPayload(r)).toMatchObject({ error: 'RATE_LIMITED', details: { scope: 'tool rh_escalas_list' } });
    // another tool is not affected
    expect((await client.callTool({ name: 'rh_colaboradores_list', arguments: { size: 1 } })).isError).toBeFalsy();
  });

  it('per-client and per-tenant rate limit', async () => {
    await setSettings({ rateLimits: { perClient: { limit: 1, windowSec: 60 } } });
    await client.callTool({ name: 'rh_escalas_list', arguments: {} });
    expect(errorPayload(await client.callTool({ name: 'rh_escalas_list', arguments: {} }))).toMatchObject({ details: { scope: 'client' } });

    await setSettings({ rateLimits: { perTenant: { limit: 1, windowSec: 60 }, perClient: null } });
    await h.services.redis.eval("for _,k in ipairs(redis.call('keys','rl:*')) do redis.call('del',k) end", 0);
    await client.callTool({ name: 'rh_escalas_list', arguments: {} });
    expect(errorPayload(await client.callTool({ name: 'rh_escalas_list', arguments: {} }))).toMatchObject({ details: { scope: 'tenant' } });
  });

  it('request and response size limits', async () => {
    await setSettings({ limits: { maxRequestBytes: 64 } });
    const big = await client.callTool({ name: 'rh_colaboradores_list', arguments: { nome: 'x'.repeat(200) } });
    expect(errorPayload(big)).toMatchObject({ error: 'VALIDATION_ERROR' });

    await setSettings({ limits: { maxResponseBytes: 2048 } });
    const r = await client.callTool({ name: 'rh_colaboradores_list', arguments: { size: 400 } });
    expect(errorPayload(r)).toMatchObject({ error: 'UPSTREAM_ERROR', message: 'upstream response exceeds the limit of 2048 bytes' });
  });

  it('the per-source circuit breaker opens after failures and closes after the cooldown', async () => {
    await setSettings({ circuitBreaker: { failureThreshold: 2, windowMs: 10_000, cooldownMs: 400 } });
    up.addFault({ status: 503, times: 2, pathPrefix: '/escalas' });
    for (let i = 0; i < 2; i++) {
      expect(errorPayload(await client.callTool({ name: 'rh_escalas_list', arguments: {} }))).toMatchObject({ status: 503 });
    }
    const before = up.requests.length;
    const open = await client.callTool({ name: 'rh_colaboradores_list', arguments: { size: 1 } });
    expect(errorPayload(open)).toMatchObject({ error: 'UPSTREAM_ERROR', details: { circuit: 'open' } });
    expect(up.requests.length).toBe(before); // fails fast, without calling the upstream

    await new Promise((r) => setTimeout(r, 450));
    expect((await client.callTool({ name: 'rh_colaboradores_list', arguments: { size: 1 } })).isError).toBeFalsy();
    expect((await client.callTool({ name: 'rh_escalas_list', arguments: {} })).isError).toBeFalsy();
  });
});

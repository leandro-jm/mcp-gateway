import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, startInfra, type Harness, type Infra } from './harness';

/** Two gateway replicas over the same Postgres/Redis: A receives the change, B serves the data plane. */
describe('registry cache (F1.5)', () => {
  let infra: Infra;
  let a: Harness;
  let b: Harness;
  let admin: string;
  let tenantId: string;
  let toolId: string;

  beforeAll(async () => {
    infra = await startInfra();
    const env = { GATEWAY_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') };
    a = await startHarness({ infra, env });
    b = await startHarness({ infra, env });
    admin = await a.adminToken('acme');
    const call = (method: string, url: string, body?: unknown) =>
      a.app.inject({ method: method as 'GET', url: `/admin/v1${url}`, headers: { authorization: `Bearer ${admin}`, 'x-tenant': 'acme' }, ...(body ? { payload: body as object } : {}) });
    tenantId = (await call('POST', '/tenants', { slug: 'acme', name: 'ACME' })).json().id;
    const sourceId = (await call('POST', '/sources', { name: 'rh', openapiUrl: 'http://x/openapi.json', baseUrl: 'http://x' })).json().id;
    toolId = (
      await a.services.repos.tools.create(tenantId, {
        kind: 'openapi',
        sourceId,
        name: 'rh_colaboradores_list',
        operationKey: 'GET /colaboradores',
        inputSchema: { type: 'object' },
      })
    ).id;
  });
  afterAll(async () => {
    await a?.teardown();
    await b?.teardown();
    await infra?.stop();
  });

  async function waitFor(fn: () => Promise<boolean>, timeoutMs: number): Promise<number> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await fn()) return Date.now() - start;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`condition not met within ${timeoutMs}ms`);
  }

  it("an Admin API change shows up on another replica's data plane in < 2 s", async () => {
    const before = await b.services.registry.get(tenantId);
    expect(before.tools.find((t) => t.id === toolId)?.state).toBe('disabled');
    // B now has the snapshot in L1 and L2.

    const res = await a.app.inject({
      method: 'POST',
      url: `/admin/v1/tools/${toolId}/enable`,
      headers: { authorization: `Bearer ${admin}`, 'x-tenant': 'acme' },
    });
    expect(res.statusCode).toBe(200);

    const elapsed = await waitFor(
      async () => (await b.services.registry.get(tenantId)).tools.find((t) => t.id === toolId)?.state === 'enabled',
      2000,
    );
    expect(elapsed).toBeLessThan(2000);

    await a.app.inject({
      method: 'PATCH',
      url: `/admin/v1/tools/${toolId}`,
      headers: { authorization: `Bearer ${admin}`, 'x-tenant': 'acme' },
      payload: { name: 'listar_colaboradores' },
    });
    await waitFor(async () => (await b.services.registry.get(tenantId)).tools[0]?.name === 'listar_colaboradores', 2000);
  });

  it('tenant settings also invalidate', async () => {
    await b.services.registry.get(tenantId);
    await a.app.inject({
      method: 'PATCH',
      url: `/admin/v1/tenants/${tenantId}`,
      headers: { authorization: `Bearer ${admin}`, 'x-tenant': 'acme' },
      payload: { settings: { rateLimit: { tenantPerMinute: 10 } } },
    });
    await waitFor(async () => {
      const s = await b.services.registry.get(tenantId);
      return JSON.stringify(s.tenant.settings).includes('tenantPerMinute');
    }, 2000);
  });

  it('the snapshot excludes removed tools and resolves the tenant by slug', async () => {
    const snap = await b.services.registry.getBySlug('acme');
    expect(snap.tenant.id).toBe(tenantId);
    expect(snap.tools.every((t) => t.state !== 'removed')).toBe(true);
  });
});

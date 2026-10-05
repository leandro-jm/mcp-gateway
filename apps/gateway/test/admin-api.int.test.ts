import SwaggerParser from '@apidevtools/swagger-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness';

const SECRET = 'secret-that-must-not-leak-9f8e7d';

describe('Admin API: tenants, sources, credentials', () => {
  let h: Harness;
  let admin: string;

  beforeAll(async () => {
    h = await startHarness();
    admin = await h.adminToken('acme');
  });
  afterAll(async () => h?.teardown());

  const call = (method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) =>
    h.app.inject({
      method: method as 'GET',
      url: `/admin/v1${url}`,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-tenant': 'acme', ...headers },
      ...(body === undefined ? {} : { payload: body as object }),
    });

  it('publishes a valid OpenAPI 3.1 with the routes', async () => {
    const res = await call('GET', '/openapi.json');
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toBe('3.1.0');
    await SwaggerParser.validate(structuredClone(spec));
    for (const p of ['/admin/v1/tenants', '/admin/v1/sources', '/admin/v1/credentials', '/admin/v1/sources/{id}/crawl']) {
      expect(spec.paths).toHaveProperty([p]);
    }
    expect(spec.components.schemas).toHaveProperty('Credential');
  });

  it('requires valid authentication and the gateway-admin role', async () => {
    expect((await call('GET', '/tenants')).statusCode).toBe(401);
    expect((await call('GET', '/tenants', 'garbage')).statusCode).toBe(401);
    const expired = await h.token({ tenant: undefined, roles: ['gateway-admin'], sub: 'admin-expired' }, { expiresIn: '-1m' });
    const r = await call('GET', '/tenants', expired);
    expect(r.statusCode).toBe(401);
    expect(r.json().message).toBe('token expired');
    const agent = await h.token({ roles: ['agent'], tenant: 'agents' });
    expect((await call('GET', '/tenants', agent)).statusCode).toBe(403);
    // the tenant created only for the token stays out of the CRUD below
    await h.services.repos.tenants.delete((await h.services.repos.tenants.findBySlug('agents'))!.id);
  });

  it('tenant CRUD', async () => {
    const created = await call('POST', '/tenants', admin, { slug: 'acme', name: 'ACME' });
    expect(created.statusCode).toBe(201);
    const t = created.json();
    expect(t).toMatchObject({ slug: 'acme', name: 'ACME', status: 'active' });
    expect(t).not.toHaveProperty('dataKeyEncrypted');
    expect((await call('POST', '/tenants', admin, { slug: 'acme', name: 'dup' })).statusCode).toBe(409);
    expect((await call('POST', '/tenants', admin, { slug: 'X Y', name: 'invalid' })).statusCode).toBe(400);
    await call('POST', '/tenants', admin, { slug: 'other', name: 'Other' });

    const list = (await call('GET', '/tenants', admin)).json();
    expect(list.total).toBe(2);
    const patched = await call('PATCH', `/tenants/${t.id}`, admin, { settings: { rateLimit: { perTenant: 100 } } });
    expect(patched.json().settings).toEqual({ rateLimit: { perTenant: 100 } });
  });

  it('credentials never appear in clear text in responses or logs', async () => {
    const created = await call('POST', '/credentials', admin, {
      name: 'rh-oauth',
      type: 'oauth2_client_credentials',
      config: { tokenUrl: 'http://up.local/oauth/token', clientId: 'gw', clientSecret: SECRET },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const bodies = [
      created.body,
      (await call('GET', '/credentials', admin)).body,
      (await call('GET', `/credentials/${id}`, admin)).body,
      (
        await call('PATCH', `/credentials/${id}`, admin, {
          config: { tokenUrl: 'http://up.local/oauth/token', clientId: 'gw', clientSecret: `${SECRET}-2` },
        })
      ).body,
    ];
    for (const b of bodies) expect(b).not.toContain(SECRET);
    expect(JSON.parse(bodies[3]!).rotatedAt).not.toBeNull();
    expect(h.logs.join('')).not.toContain(SECRET);
    const dump = JSON.stringify((await h.services.dbHandle.pool.query('SELECT * FROM credentials')).rows);
    expect(dump).not.toContain(SECRET);
  });

  it('validates the configuration per credential type', async () => {
    const r = await call('POST', '/credentials', admin, { name: 'x', type: 'api_key', config: { name: 'X-Key' } });
    expect(r.statusCode).toBe(400);
  });

  it('source CRUD, tenant isolation and crawl enqueueing', async () => {
    const cred = (await call('GET', '/credentials', admin)).json().items[0];
    const res = await call('POST', '/sources', admin, {
      name: 'rh',
      openapiUrl: 'http://up.local/openapi.json',
      baseUrl: 'http://up.local',
      credentialId: cred.id,
      ownerTeam: 'team-rh',
    });
    expect(res.statusCode).toBe(201);
    const source = res.json();
    expect(source).toMatchObject({ name: 'rh', hasInlineSpec: false, status: 'active' });

    // no spec
    expect((await call('POST', '/sources', admin, { name: 'no_spec', baseUrl: 'http://x' })).statusCode).toBe(400);

    // credential of another tenant
    const otherCred = await call(
      'POST',
      '/credentials',
      admin,
      { name: 'k', type: 'bearer_static', config: { token: 't' } },
      { 'x-tenant': 'other' },
    );
    const bad = await call('POST', '/sources', admin, {
      name: 'rh2',
      openapiUrl: 'http://up.local/openapi.json',
      baseUrl: 'http://up.local',
      credentialId: otherCred.json().id,
    });
    expect(bad.statusCode).toBe(400);

    // another tenant cannot see the source
    expect((await call('GET', `/sources/${source.id}`, admin, undefined, { 'x-tenant': 'other' })).statusCode).toBe(404);

    // a tool-owner cannot target another tenant
    const owner = await h.token({ roles: ['tool-owner'], tenant: 'acme', groups: ['team-rh'] });
    expect((await call('GET', '/sources', owner)).statusCode).toBe(200);
    const cross = await call('GET', '/sources', owner, undefined, { 'x-tenant': 'other' });
    expect(cross.statusCode).toBe(403);
    expect(cross.json().message).toBe('access to another tenant is not allowed');
    expect((await call('DELETE', `/sources/${source.id}`, owner)).statusCode).toBe(403);

    // manual crawl
    const crawl = await call('POST', `/sources/${source.id}/crawl`, admin);
    expect(crawl.statusCode).toBe(202);
    const run = crawl.json();
    expect(run.status).toBe('queued');
    const job = await h.services.queues.crawl.getJob(run.id);
    expect(job?.name).toBe('crawl-source');
    expect(job?.data).toMatchObject({ sourceId: source.id, runId: run.id, trigger: 'manual' });
    expect((await call('GET', `/sources/${source.id}/crawl-runs`, admin)).json().items).toHaveLength(1);

    // a credential in use cannot be deleted
    expect((await call('DELETE', `/credentials/${cred.id}`, admin)).statusCode).toBe(409);
    expect((await call('DELETE', `/sources/${source.id}`, admin)).statusCode).toBe(204);
    expect((await call('DELETE', `/credentials/${cred.id}`, admin)).statusCode).toBe(204);
  });
});

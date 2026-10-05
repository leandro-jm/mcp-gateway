import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness';
import { seedRhTenant } from './seed';

describe('data plane AuthN (F4.1, ADR-011)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let base: string;

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    await seedRhTenant(h, up, { slug: 'acme' });
    await h.services.repos.tenants.create({ slug: 'other', name: 'Other' });
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
  });

  const post = (token?: string, headers: Record<string, string> = {}, path = '/mcp') =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

  it('a valid tenant token is accepted', async () => {
    const res = await post(await h.token({ tenant: 'acme' }));
    expect(res.status).toBe(200);
  });

  it.each([
    ['missing', async () => undefined, {}],
    ['malformed', async () => 'abc.def.ghi', {}],
    ['unknown', async () => 'mgw_does-not-exist', {}],
    ['expired', (hh: Harness) => hh.token({ tenant: 'acme' }, { expiresIn: '-2m' }), {}],
    ['of another tenant (X-Tenant)', (hh: Harness) => hh.token({ tenant: 'other' }), { 'x-tenant': 'acme' }],
    ['of a platform admin (no tenant)', (hh: Harness) => hh.token({ tenant: undefined, roles: ['gateway-admin'] }), {}],
  ] as const)('401 for a token that is %s', async (_label, make, headers) => {
    const res = await post(await make(h), headers as Record<string, string>);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer realm="mcp-gateway"/);
  });

  it('401 for a suspended tenant', async () => {
    const token = await h.token({ tenant: 'suspended', sub: 'u-suspended' });
    const t = await h.services.repos.tenants.findBySlug('suspended');
    await h.services.repos.tenants.update(t!.id, { status: 'suspended' });
    await h.services.registry.invalidate(t!.id);
    expect((await post(token)).status).toBe(401);
  });

  it('a revoked token stops working immediately', async () => {
    const token = await h.token({ tenant: 'acme', sub: 'revoked' });
    expect((await post(token)).status).toBe(200);
    const user = await h.services.repos.auth.findUser('revoked');
    const [t] = await h.services.repos.auth.listTokens(user!.id);
    h.services.verifier.forget(await h.services.repos.auth.revokeToken(user!.id, t!.id));
    const res = await post(token);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('token revoked');
    // unauthenticated: the message follows Accept-Language
    const es = await post(token, { 'accept-language': 'es' });
    expect(((await es.json()) as { error: { message: string } }).error.message).toBe('token revocado');
  });

  it('a disabled user does not authenticate', async () => {
    const token = await h.token({ tenant: 'acme', sub: 'disabled' });
    const user = await h.services.repos.auth.findUser('disabled');
    await h.services.repos.users.update(user!.tenantId!, user!.id, { status: 'disabled' });
    h.services.verifier.clear();
    expect((await post(token)).status).toBe(401);
  });
});

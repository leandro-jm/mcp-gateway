import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness';

const SETUP_TOKEN = 'setup-token-for-tests-0123456789';

describe('first-run setup (ADR-024)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ env: { SETUP_TOKEN } });
  });
  afterAll(async () => h?.teardown());

  const call = (method: 'GET' | 'POST', url: string, body?: object, headers: Record<string, string> = {}) =>
    h.app.inject({ method, url: `/admin/v1${url}`, headers, ...(body ? { payload: body } : {}) });
  const setup = (overrides: Record<string, unknown> = {}) =>
    call('POST', '/setup', {
      setupToken: SETUP_TOKEN,
      username: 'owner-admin',
      password: 'a-strong-password',
      locale: 'pt-BR',
      tenant: { slug: 'niflow', name: 'Niflow' },
      ...overrides,
    });
  const config = () => h.services.config as { SETUP_TOKEN?: string };

  it('an empty instance reports setup as needed and enabled', async () => {
    const res = await call('GET', '/setup');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ needed: true, enabled: true });
  });

  it('without SETUP_TOKEN the setup is disabled', async () => {
    config().SETUP_TOKEN = undefined;
    try {
      expect((await call('GET', '/setup')).json()).toEqual({ needed: true, enabled: false });
      const res = await setup();
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toContain('SETUP_TOKEN');
    } finally {
      config().SETUP_TOKEN = SETUP_TOKEN;
    }
  });

  it('a wrong token is rejected and creates nothing', async () => {
    const res = await setup({ setupToken: 'wrong' });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('invalid setup token');
    expect(await h.services.repos.auth.hasUsers()).toBe(false);
    expect(await h.services.repos.tenants.findBySlug('niflow')).toBeUndefined();
  });

  it('creates the tenant and a platform admin, and returns a working session', async () => {
    const res = await setup();
    expect(res.statusCode).toBe(200);
    const { token, expiresAt, tenant } = res.json();
    expect(token).toMatch(/^mgw_/);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(tenant).toBe('niflow');

    const me = await call('GET', '/me', undefined, { authorization: `Bearer ${token}` });
    expect(me.json()).toMatchObject({ sub: 'owner-admin', tenant: null, isAdmin: true, locale: 'pt-BR' });
    const tenants = await call('GET', '/tenants', undefined, { authorization: `Bearer ${token}` });
    expect(tenants.json().items.map((t: { slug: string }) => t.slug)).toEqual(['niflow']);

    const login = await call('POST', '/auth/login', { username: 'owner-admin', password: 'a-strong-password' });
    expect(login.statusCode).toBe(200);
  });

  it('never acts again once a user exists, even with the right token', async () => {
    expect((await call('GET', '/setup')).json()).toEqual({ needed: false, enabled: false });
    const res = await setup({ username: 'intruder', tenant: { slug: 'other', name: 'Other' } });
    expect(res.statusCode).toBe(409);
    expect(await h.services.repos.auth.findUser('intruder')).toBeUndefined();
    expect(await h.services.repos.tenants.findBySlug('other')).toBeUndefined();
  });

  it('concurrent setups on an empty instance create a single admin', async () => {
    const fresh = await startHarness({ env: { SETUP_TOKEN } });
    try {
      const results = await Promise.all(
        ['a', 'b', 'c'].map((n) =>
          fresh.app.inject({
            method: 'POST',
            url: '/admin/v1/setup',
            payload: { setupToken: SETUP_TOKEN, username: `admin-${n}`, password: 'a-strong-password', tenant: { slug: `t-${n}`, name: n } },
          }),
        ),
      );
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
      const { rows } = await fresh.services.dbHandle.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM users');
      expect(rows[0]!.n).toBe('1');
    } finally {
      await fresh.teardown();
    }
  });
});

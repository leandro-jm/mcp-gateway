import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness';
import { mintOAuthToken, setTenantOAuth } from './oauth-helpers';

describe('OAuth in the Admin API (F20.8, ADR-030)', () => {
  let h: Harness;
  let admin: string;
  let platformAdmin: string;

  const call = (token: string, method: string, url: string, body?: unknown, tenant: string | null = 'acme') =>
    h.app.inject({
      method: method as 'GET',
      url: `/admin/v1${url}`,
      headers: { authorization: `Bearer ${token}`, ...(tenant ? { 'x-tenant': tenant } : {}) },
      ...(body ? { payload: body as object } : {}),
    });
  const works = async (token: string) => {
    h.services.verifier.clear();
    try {
      await h.services.verifier.verify(token);
      return true;
    } catch {
      return false;
    }
  };

  beforeAll(async () => {
    h = await startHarness({ env: { OAUTH_ENABLED: 'true' } });
    await h.services.repos.tenants.create({ slug: 'acme', name: 'ACME' });
    admin = await h.token({ sub: 'acme-admin', tenant: 'acme', roles: ['gateway-admin'], azp: 'admin-ui' });
    platformAdmin = await h.adminToken('platform');
    await setTenantOAuth(h, 'acme', { enabled: true, clients: 'any' });
  });
  afterAll(async () => h?.teardown());

  it('reads and saves the tenant settings, validating allowlist entries', async () => {
    const view = await call(admin, 'GET', '/settings/oauth');
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({
      platformEnabled: true,
      dcrEnabled: true,
      issuer: 'http://gateway.test',
      platformAccessTtlMinutes: 60,
      settings: { enabled: true, clients: 'any', allowlist: [], accessTtlMinutes: null },
    });

    const bad = await call(admin, 'PUT', '/settings/oauth', { enabled: true, clients: 'allowlist', allowlist: ['javascript:alert(1)'] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain('invalid allowlist entry');

    const saved = await call(admin, 'PUT', '/settings/oauth', {
      enabled: true,
      clients: 'allowlist',
      allowlist: ['claude.ai', 'https://other.example/meta', 'dcr_abcdefgh12', 'claude.ai'],
      accessTtlMinutes: 15,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings).toEqual({
      enabled: true,
      clients: 'allowlist',
      allowlist: ['claude.ai', 'https://other.example/meta', 'dcr_abcdefgh12'],
      accessTtlMinutes: 15,
      refreshTtlDays: null,
    });
    const tenantId = (await h.services.repos.tenants.findBySlug('acme'))!.id;
    expect((await h.services.repos.audit.list(tenantId, { action: 'settings.oauth.update' }))[0]).toMatchObject({ subject: 'acme-admin' });
    await setTenantOAuth(h, 'acme', { enabled: true, clients: 'any' });
  });

  it('turning OAuth off stops the tenant apps at once', async () => {
    const { token } = await mintOAuthToken(h, { sub: 'off-switch', tenant: 'acme' });
    expect(await works(token)).toBe(true);
    await call(admin, 'PUT', '/settings/oauth', { enabled: false, clients: 'any', allowlist: [] });
    await expect(h.services.verifier.verify(token)).rejects.toThrow();
    await setTenantOAuth(h, 'acme', { enabled: true, clients: 'any' });
  });

  it('lets a person see and disconnect only their own apps', async () => {
    const mine = await mintOAuthToken(h, { sub: 'pessoa', tenant: 'acme' });
    const theirs = await mintOAuthToken(h, { sub: 'colega', tenant: 'acme' });
    const session = await h.token({ sub: 'pessoa', tenant: 'acme', azp: 'admin-ui' });

    const list = await call(session, 'GET', '/me/oauth/grants', undefined, null);
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((g: { id: string }) => g.id)).toEqual([mine.grantId]);
    expect(list.json().items[0]).toMatchObject({ username: 'pessoa', policyClientId: 'oauth:claude.ai', clientKind: 'cimd', scopes: ['mcp'] });

    expect((await call(session, 'DELETE', `/me/oauth/grants/${theirs.grantId}`, undefined, null)).statusCode).toBe(404);
    expect(await works(theirs.token)).toBe(true);
    expect((await call(session, 'DELETE', `/me/oauth/grants/${mine.grantId}`, undefined, null)).statusCode).toBe(204);
    await expect(h.services.verifier.verify(mine.token)).rejects.toThrow();
  });

  it('lets the tenant admin list and revoke connected apps of anyone in the tenant', async () => {
    const target = await mintOAuthToken(h, { sub: 'alvo', tenant: 'acme', clientId: 'dcr_admin-test', kind: 'dcr' });
    const user = await h.services.repos.auth.findUser('alvo');
    const listed = await call(admin, 'GET', `/oauth/grants?userId=${user!.id}`);
    expect(listed.json().items).toEqual([expect.objectContaining({ id: target.grantId, policyClientId: 'oauth:dcr:dcr_admin-test', clientKind: 'dcr' })]);
    expect((await call(admin, 'DELETE', `/oauth/grants/${target.grantId}`)).statusCode).toBe(204);
    await expect(h.services.verifier.verify(target.token)).rejects.toThrow();
    expect((await call(admin, 'DELETE', `/oauth/grants/${target.grantId}`)).statusCode).toBe(404);
  });

  it('revokes connected apps when a person is disabled or their password is reset', async () => {
    const disabled = await mintOAuthToken(h, { sub: 'sai', tenant: 'acme' });
    const sai = await h.services.repos.auth.findUser('sai');
    expect((await call(admin, 'PATCH', `/users/${sai!.id}`, { status: 'disabled' })).statusCode).toBe(200);
    await call(admin, 'PATCH', `/users/${sai!.id}`, { status: 'active' });
    // enabling the person again does not bring the app back
    await expect(h.services.verifier.verify(disabled.token)).rejects.toThrow();

    const reset = await mintOAuthToken(h, { sub: 'nova-senha', tenant: 'acme' });
    const user = await h.services.repos.auth.findUser('nova-senha');
    expect((await call(admin, 'PUT', `/users/${user!.id}/password`, { password: 'a-brand-new-password' })).statusCode).toBe(204);
    await expect(h.services.verifier.verify(reset.token)).rejects.toThrow();
  });

  it('lets the platform admin list apps and disable one on every tenant', async () => {
    const victim = await mintOAuthToken(h, { sub: 'plataforma', tenant: 'acme', clientId: 'https://shady.example/meta' });
    const list = await call(platformAdmin, 'GET', '/platform/oauth/clients', undefined, null);
    expect(list.statusCode).toBe(200);
    const shady = list.json().items.find((c: { clientId: string }) => c.clientId === 'https://shady.example/meta');
    expect(shady).toMatchObject({ kind: 'cimd', policyClientId: 'oauth:shady.example', activeGrants: 1, disabledAt: null });

    const off = await call(platformAdmin, 'PATCH', `/platform/oauth/clients/${shady.id}`, { disabled: true }, null);
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ activeGrants: 0 });
    expect(off.json().disabledAt).not.toBeNull();
    await expect(h.services.verifier.verify(victim.token)).rejects.toThrow();

    const on = await call(platformAdmin, 'PATCH', `/platform/oauth/clients/${shady.id}`, { disabled: false }, null);
    expect(on.json().disabledAt).toBeNull();
    expect((await call(admin, 'GET', '/platform/oauth/clients')).statusCode).toBe(403);
  });
});

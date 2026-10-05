import { hashPassword } from '@mcp-gateway/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness';

describe('Admin API: login, users and tokens (ADR-011)', () => {
  let h: Harness;
  let admin: string;

  beforeAll(async () => {
    h = await startHarness({ env: { AUTH_LOGIN_RATE_LIMIT: '5' } });
    await h.services.repos.tenants.create({ slug: 'acme', name: 'ACME' });
    await h.services.repos.tenants.create({ slug: 'other', name: 'Other' });
    await h.services.repos.auth.createUser(null, { username: 'root', roles: ['gateway-admin'], passwordHash: await hashPassword('root-password') });
    admin = await h.adminToken('does-not-exist'); // platform admin
  });
  afterAll(async () => h?.teardown());

  const call = (method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) =>
    h.app.inject({
      method: method as 'GET',
      url: `/admin/v1${url}`,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body === undefined ? {} : { payload: body as object }),
    });
  const mcp = (token: string) =>
    h.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
  const login = (username: string, password: string) => call('POST', '/auth/login', undefined, { username, password });

  it('login returns a session token; /me reflects the user; logout revokes', async () => {
    const res = await login('root', 'root-password');
    expect(res.statusCode).toBe(200);
    const { token, expiresAt } = res.json();
    expect(token).toMatch(/^mgw_/);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now() + 11 * 3600_000);
    const me = await call('GET', '/me', token);
    expect(me.json()).toMatchObject({ sub: 'root', tenant: null, isAdmin: true, locale: 'en' });

    expect((await call('POST', '/auth/logout', token)).statusCode).toBe(204);
    expect((await call('GET', '/me', token)).statusCode).toBe(401);
  });

  it('an invalid login has a generic message that does not reveal whether the user exists', async () => {
    const wrong = await login('root', 'wrong');
    const missing = await login('nobody', 'x');
    expect(wrong.statusCode).toBe(401);
    expect(missing.statusCode).toBe(401);
    expect(wrong.json().message).toBe(missing.json().message);
    expect(wrong.json().message).toBe('invalid username or password');
    const es = await h.app.inject({ method: 'POST', url: '/admin/v1/auth/login', headers: { 'accept-language': 'es' }, payload: { username: 'root', password: 'wrong' } });
    expect(es.json().message).toBe('usuario o contraseña inválidos');
  });

  it('login is rate limited per user', async () => {
    for (let i = 0; i < 5; i++) await login('target', 'x');
    expect((await login('target', 'x')).statusCode).toBe(429);
  });

  it('a platform admin needs X-Tenant on tenant routes', async () => {
    const missing = await call('GET', '/users', admin);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().message).toBe('tenant not provided (X-Tenant header)');
    expect((await call('GET', '/users', admin, undefined, { 'x-tenant': 'acme' })).statusCode).toBe(200);
  });

  it('user CRUD: the password never leaves, the created user logs in, deactivation', async () => {
    const acme = { 'x-tenant': 'acme' };
    const created = await call('POST', '/users', admin, { username: 'maria', displayName: 'Maria', password: 'strong-password', roles: ['tool-owner'], groups: ['team-rh'], locale: 'pt-BR' }, acme);
    expect(created.statusCode).toBe(201);
    const u = created.json();
    expect(u).toMatchObject({ username: 'maria', kind: 'human', hasPassword: true, status: 'active', locale: 'pt-BR' });
    expect(created.body).not.toContain('scrypt');
    expect((await call('POST', '/users', admin, { username: 'maria' }, acme)).statusCode).toBe(409);
    const service = await call('POST', '/users', admin, { username: 'bot', kind: 'service', password: 'strong-password' }, acme);
    expect(service.statusCode).toBe(400);
    expect(service.json().message).toBe('service users have no password; use tokens');
    expect((await call('POST', '/users', admin, { username: 'bad-locale', locale: 'fr' }, acme)).statusCode).toBe(400);
    expect((await call('POST', '/users', admin, { username: 'default-locale', kind: 'service' }, acme)).json().locale).toBe('en');

    const session = (await login('maria', 'strong-password')).json().token;
    expect((await call('GET', '/me', session)).json()).toMatchObject({ sub: 'maria', name: 'Maria', tenant: 'acme', isOwner: true, groups: ['team-rh'], locale: 'pt-BR' });
    // owners don't manage users; the error comes in the user's language
    const forbidden = await call('GET', '/users', session);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().message).toBe('requer uma das roles: gateway-admin');

    // the admin changes the user's language; it applies to tokens already issued
    const patched = await call('PATCH', `/users/${u.id}`, admin, { locale: 'es' }, acme);
    expect(patched.statusCode).toBe(200);
    expect(patched.json().locale).toBe('es');
    expect((await call('GET', '/users', session)).json().message).toBe('requiere uno de los roles: gateway-admin');
    expect((await call('PATCH', `/users/${u.id}`, admin, { locale: 'xx' }, acme)).statusCode).toBe(400);

    expect((await call('PUT', `/users/${u.id}/password`, admin, { password: 'another-password' }, acme)).statusCode).toBe(204);
    expect((await login('maria', 'strong-password')).statusCode).toBe(401);
    expect((await login('maria', 'another-password')).statusCode).toBe(200);

    expect((await call('PATCH', `/users/${u.id}`, admin, { status: 'disabled' }, acme)).statusCode).toBe(200);
    expect((await call('GET', '/me', session)).statusCode).toBe(401);
    expect((await login('maria', 'another-password')).statusCode).toBe(401);

    // another tenant cannot see the user
    expect((await call('GET', `/users/${u.id}`, admin, undefined, { 'x-tenant': 'other' })).statusCode).toBe(404);
  });

  it('service user API tokens: value shown once, valid on the data plane, revoked immediately', async () => {
    const acme = { 'x-tenant': 'acme' };
    const bot = (await call('POST', '/users', admin, { username: 'ponto-bot', kind: 'service', roles: ['agent'], attributes: { unidades: ['u1'] } }, acme)).json();
    expect(bot.hasPassword).toBe(false);
    const created = await call('POST', `/users/${bot.id}/tokens`, admin, { name: 'ponto-bot', expiresInDays: 30 }, acme);
    expect(created.statusCode).toBe(201);
    const { token, id, prefix } = created.json();
    expect(token.startsWith(prefix)).toBe(true);

    const list = (await call('GET', `/users/${bot.id}/tokens`, admin, undefined, acme)).json();
    expect(list.items).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(token);
    // another tenant can neither see nor revoke the token
    expect((await call('GET', `/users/${bot.id}/tokens`, admin, undefined, { 'x-tenant': 'other' })).statusCode).toBe(404);
    expect((await call('DELETE', `/users/${bot.id}/tokens/${id}`, admin, undefined, { 'x-tenant': 'other' })).statusCode).toBe(404);

    expect((await mcp(token)).statusCode).toBe(200);
    const row = await h.services.repos.auth.findUser('ponto-bot');
    expect(row?.attributes).toEqual({ unidades: ['u1'] });

    expect((await call('DELETE', `/users/${bot.id}/tokens/${id}`, admin, undefined, acme)).statusCode).toBe(204);
    expect((await mcp(token)).statusCode).toBe(401);
  });

  it('each user manages their own tokens at /me/tokens', async () => {
    const own = await h.token({ tenant: 'acme', sub: 'agent-self', roles: ['agent'] });
    const created = (await call('POST', '/me/tokens', own, { name: 'my-cli' })).json();
    // self-issued tokens always expire (90 days by default)
    expect(new Date(created.expiresAt).getTime() - Date.now()).toBeGreaterThan(89 * 24 * 3600 * 1000);
    expect((await call('POST', '/me/tokens', own, { name: 'forever', expiresInDays: 3650 })).statusCode).toBe(400);
    expect((await call('GET', '/me/tokens', own)).json().items.map((t: { name: string }) => t.name)).toContain('my-cli');
    expect((await mcp(created.token)).statusCode).toBe(200);
    expect((await call('DELETE', `/me/tokens/${created.id}`, own)).statusCode).toBe(204);
    expect((await mcp(created.token)).statusCode).toBe(401);
  });

  it('deleting the user invalidates their tokens', async () => {
    const acme = { 'x-tenant': 'acme' };
    const u = (await call('POST', '/users', admin, { username: 'temporary', kind: 'service', roles: ['agent'] }, acme)).json();
    const { token } = (await call('POST', `/users/${u.id}/tokens`, admin, { name: 'tmp' }, acme)).json();
    expect((await mcp(token)).statusCode).toBe(200);
    expect((await call('DELETE', `/users/${u.id}`, admin, undefined, acme)).statusCode).toBe(204);
    expect((await mcp(token)).statusCode).toBe(401);
  });
});

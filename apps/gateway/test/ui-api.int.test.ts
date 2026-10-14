import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness';
import { seedRhTenant, type SeededTenant } from './seed';

describe('Admin UI endpoints (F10)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let admin: string;
  let owner: string;

  const call = (token: string, method: string, url: string, body?: unknown) =>
    h.app.inject({ method: method as 'GET', url: `/admin/v1${url}`, headers: { authorization: `Bearer ${token}`, 'x-tenant': 'acme' }, ...(body ? { payload: body as object } : {}) });
  const MISSING_TOOL = '00000000-0000-4000-8000-000000000000';

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    seeded = await seedRhTenant(h, up);
    admin = await h.adminToken('acme');
    owner = await h.token({ roles: ['tool-owner'], tenant: 'acme', groups: ['team-rh'], sub: 'owner-1', name: 'Owner RH' });
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
  });

  it('/me', async () => {
    expect((await call(owner, 'GET', '/me')).json()).toMatchObject({ sub: 'owner-1', name: 'Owner RH', tenant: 'acme', isAdmin: false, isOwner: true, groups: ['team-rh'], locale: 'en', publicUrl: expect.any(String) });
  });

  it('PATCH /me changes the language of later responses (ADR-012)', async () => {
    const user = await h.token({ roles: ['tool-owner'], tenant: 'acme', groups: ['team-rh'], sub: 'owner-locale' });
    expect((await call(user, 'GET', '/me')).json()).toMatchObject({ sub: 'owner-locale', locale: 'en' });
    const before = await call(user, 'GET', `/tools/${MISSING_TOOL}`);
    expect(before.statusCode).toBe(404);
    expect(before.json()).toMatchObject({ error: 'NOT_FOUND', message: `tool not found: ${MISSING_TOOL}` });

    const patched = await call(user, 'PATCH', '/me', { locale: 'es' });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ sub: 'owner-locale', locale: 'es' });
    expect((await call(user, 'GET', '/me')).json().locale).toBe('es');
    expect((await h.services.repos.auth.findUser('owner-locale'))?.locale).toBe('es');

    const after = await call(user, 'GET', `/tools/${MISSING_TOOL}`);
    expect(after.statusCode).toBe(404);
    expect(after.json()).toMatchObject({ error: 'NOT_FOUND', message: `No encontrado: tool ${MISSING_TOOL}`, details: { resource: 'tool', id: MISSING_TOOL } });
    // the profile wins over Accept-Language
    const header = await h.app.inject({
      method: 'GET',
      url: '/admin/v1/users',
      headers: { authorization: `Bearer ${user}`, 'x-tenant': 'acme', 'accept-language': 'pt-BR' },
    });
    expect(header.statusCode).toBe(403);
    expect(header.json().message).toBe('requiere uno de los roles: gateway-admin');

    const invalid = await call(user, 'PATCH', '/me', { locale: 'fr' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe('VALIDATION_ERROR');
    expect((await call(user, 'GET', '/me')).json().locale).toBe('es');
  });

  it('unauthenticated requests use Accept-Language', async () => {
    const login = (lang?: string) =>
      h.app.inject({
        method: 'POST',
        url: '/admin/v1/auth/login',
        headers: lang ? { 'accept-language': lang } : {},
        payload: { username: 'nobody', password: 'wrong' },
      });
    expect((await login()).json()).toMatchObject({ error: 'UNAUTHORIZED', message: 'invalid username or password' });
    expect((await login('es-AR,es;q=0.9')).json().message).toBe('usuario o contraseña inválidos');
    expect((await login('pt-BR')).json().message).toBe('usuário ou senha inválidos');
    const noBearer = await h.app.inject({ method: 'GET', url: '/admin/v1/me', headers: { 'accept-language': 'es' } });
    expect(noBearer.statusCode).toBe(401);
    expect(noBearer.json().message).toBe('falta el header Authorization Bearer');
  });

  it('playground: redacted final for everyone; raw only for gateway-admin', async () => {
    const colab = up.data.colaboradores[0]!;
    const body = { tool: 'rh_colaborador_get', arguments: { id: colab.id }, subject: { roles: ['agent'] } };
    const asAdmin = (await call(admin, 'POST', '/playground/call', body)).json();
    expect(asAdmin).toMatchObject({ decision: 'allow', status: 200, rawVisible: true });
    expect(asAdmin.raw.cpf).toBe(colab.cpf);
    expect(asAdmin.final.cpf).toMatch(/^\*\*\*/);
    expect(asAdmin.redactions).toBeGreaterThan(0);
    const asOwner = (await call(owner, 'POST', '/playground/call', body)).json();
    expect(asOwner).toMatchObject({ rawVisible: false, raw: null });
    const denied = (await call(admin, 'POST', '/playground/call', { ...body, subject: { roles: ['nobody'] } })).json();
    expect(denied.decision).toBe('deny');
    expect(JSON.parse(denied.result.content[0].text)).toMatchObject({ error: 'TOOL_NOT_FOUND', message: 'Unknown tool: rh_colaborador_get' });
    // protocol errors are rendered in the caller's locale
    const spanish = await h.token({ roles: ['tool-owner'], tenant: 'acme', groups: ['team-rh'], sub: 'owner-es-playground', locale: 'es' });
    const deniedEs = (await call(spanish, 'POST', '/playground/call', { ...body, subject: { roles: ['nobody'] } })).json();
    expect(deniedEs.decision).toBe('deny');
    expect(JSON.parse(deniedEs.result.content[0].text).message).toBe('Tool desconocida: rh_colaborador_get');
  });

  it('drift inbox: lists and acknowledges', async () => {
    const tool = await h.services.repos.tools.get(seeded.tenantId, seeded.tools.rh_escalas_list!);
    await h.services.repos.drift.create(seeded.tenantId, { toolId: tool.id, kind: 'breaking', diff: { summary: 'test' } });
    const list = (await call(owner, 'GET', '/drift-events?pending=true')).json();
    expect(list.items[0]).toMatchObject({ toolName: 'rh_escalas_list', kind: 'breaking', acknowledgedAt: null });
    const acked = (await call(owner, 'POST', `/drift-events/${list.items[0].id}/ack`)).json();
    expect(acked.acknowledgedBy).toBe('owner-1');
    expect((await call(owner, 'GET', '/drift-events?pending=true')).json().total).toBe(0);
  });
});

import { startFakeDecisions, type FakeDecisionsServer } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness';

const KEY = 'sk-proj-tenant-decisions-secret-4f2a';

describe('tool router settings API (F19.9)', () => {
  let h: Harness;
  let admin: string;
  let decisions: FakeDecisionsServer;

  const call = (method: string, url: string, body?: unknown, token = admin) =>
    h.app.inject({
      method: method as 'GET',
      url: `/admin/v1${url}`,
      headers: { authorization: `Bearer ${token}`, 'x-tenant': 'acme' },
      ...(body ? { payload: body as object } : {}),
    });

  beforeAll(async () => {
    h = await startHarness({ env: { TOOL_ROUTER_ENABLED: 'true' } });
    decisions = await startFakeDecisions({ apiKey: KEY });
    if (!(await h.services.repos.tenants.findBySlug('acme'))) await h.services.repos.tenants.create({ slug: 'acme', name: 'ACME' });
    admin = await h.adminToken('acme');
  });
  afterAll(async () => {
    await h?.teardown();
    await decisions?.close();
  });

  it('starts off and unconfigured', async () => {
    const r = await call('GET', '/settings/tool-router');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ platformEnabled: true, settings: { enabled: false, rerank: { enabled: true }, shortlist: { enabled: false }, gate: { enabled: false } }, provider: { configured: false } });
  });

  it('refuses to enable the router without a provider, and rejects invalid settings', async () => {
    const r = await call('PUT', '/settings/tool-router', { enabled: true });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ details: { code: 'ROUTER_NOT_CONFIGURED' } });
    const bad = await call('PUT', '/settings/tool-router', { gate: { confirmAt: 0.95, denyAt: 0.5 } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain('invalid tool router settings');
  });

  it('stores the provider with a write-only key and tests it against the provider', async () => {
    const saved = await call('PUT', '/settings/tool-router/provider', { provider: 'openai_decisions', baseUrl: decisions.url, apiKey: KEY });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ configured: true, provider: 'openai_decisions', model: 'gpt-6-luna', hasApiKey: true, apiKeyHint: '4f2a' });
    expect(saved.body).not.toContain(KEY);
    expect((await call('GET', '/settings/tool-router')).body).not.toContain(KEY);

    const ok = await call('POST', '/settings/tool-router/test', {});
    expect(ok.json()).toMatchObject({ ok: true });
    expect(decisions.requests.at(-1)!.path).toBe('/v1/decisions');

    const adminPt = await h.token({ sub: 'admin-pt', roles: ['gateway-admin'], tenant: 'acme', azp: 'admin-ui', locale: 'pt-BR' });
    const wrong = await call('POST', '/settings/tool-router/test', { apiKey: 'sk-wrong-key-0000000000' }, adminPt);
    expect(wrong.json()).toEqual({ ok: false, latencyMs: expect.any(Number), error: 'o provedor de decisão recusou a API key' });

    const audit = (await call('GET', '/audit?action=settings.toolRouter.provider.update')).body;
    expect(audit).toContain('"key":"replaced"');
    expect(audit).not.toContain(KEY);
    expect(h.logs.join('\n')).not.toContain(KEY);
  });

  it('enables points per tenant; switching provider without a key drops the old key', async () => {
    const on = await call('PUT', '/settings/tool-router', { enabled: true, gate: { enabled: true, onError: 'deny' } });
    expect(on.statusCode).toBe(200);
    expect(on.json().settings).toMatchObject({ enabled: true, gate: { enabled: true, onError: 'deny', confirmAt: 0.5 } });
    const tenant = await h.services.repos.tenants.findBySlug('acme');
    expect((await h.services.registry.get(tenant!.id)).tenant.settings).toMatchObject({ toolRouter: { enabled: true } });

    const jev = await call('PUT', '/settings/tool-router/provider', { provider: 'jev', baseUrl: decisions.url });
    expect(jev.json()).toMatchObject({ provider: 'jev', model: 'jev-latest', hasApiKey: false });
    expect((await call('POST', '/settings/tool-router/test', {})).statusCode).toBe(400);

    // turning off keeps the configuration for later
    const off = await call('PUT', '/settings/tool-router', { ...on.json().settings, enabled: false });
    expect(off.json().settings).toMatchObject({ enabled: false, gate: { enabled: true, onError: 'deny' } });

    expect((await call('DELETE', '/settings/tool-router/provider')).statusCode).toBe(204);
    expect((await call('GET', '/settings/tool-router')).json().provider).toEqual({ configured: false });
  });

  it('a private base URL is blocked when the tenant network policy forbids it', async () => {
    const tenant = (await h.services.repos.tenants.findBySlug('acme'))!;
    await h.services.repos.tenants.update(tenant.id, { settings: { ...tenant.settings, network: { allowPrivate: false } } });
    const r = await call('PUT', '/settings/tool-router/provider', { provider: 'openai_decisions', baseUrl: 'http://127.0.0.1:9/v1', apiKey: KEY });
    expect(r.statusCode).toBe(400);
    await h.services.repos.tenants.update(tenant.id, { settings: tenant.settings });
  });
});

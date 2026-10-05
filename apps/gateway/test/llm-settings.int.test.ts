import { ValidationError } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeLlm } from './fake-llm';
import { startHarness, type Harness } from './harness';

const KEY = 'sk-ant-api03-tenant-secret-key-7c1d';

describe('LLM settings API (F14.3)', () => {
  let h: Harness;
  let admin: string;
  let owner: string;
  let otherAdmin: string;
  const llm = new FakeLlm();

  const call = (method: string, url: string, token: string, body?: unknown, tenant = 'acme') =>
    h.app.inject({ method: method as 'GET', url: `/admin/v1${url}`, headers: { authorization: `Bearer ${token}`, 'x-tenant': tenant }, ...(body ? { payload: body as object } : {}) });

  beforeAll(async () => {
    h = await startHarness({ llm: llm.factory });
    admin = await h.adminToken('acme');
    owner = await h.token({ roles: ['tool-owner'], tenant: 'acme', groups: ['team-rh'], sub: 'owner-1' });
    if (!(await h.services.repos.tenants.findBySlug('globex'))) await h.services.repos.tenants.create({ slug: 'globex', name: 'Globex' });
    otherAdmin = await h.adminToken('globex');
  });
  afterAll(async () => h?.teardown());

  it('starts unconfigured', async () => {
    const r = await call('GET', '/settings/llm', owner);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ configured: false });
  });

  it('only gateway-admin writes; the key is write-only and never audited', async () => {
    expect((await call('PUT', '/settings/llm', owner, { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: KEY })).statusCode).toBe(403);

    const r = await call('PUT', '/settings/llm', admin, { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: KEY, baseUrl: 'http://ignored.example' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ configured: true, provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: null, hasApiKey: true, apiKeyHint: '7c1d' });
    expect(r.body).not.toContain(KEY);

    const asAdmin = await call('GET', '/settings/llm', admin);
    expect(asAdmin.body).not.toContain(KEY);
    expect((await call('GET', '/settings/llm', owner)).json()).toEqual({ configured: true, provider: 'anthropic', model: 'claude-opus-5-5' });

    const audit = (await call('GET', '/audit?action=settings.llm.update', admin)).body;
    expect(audit).toContain('settings.llm.update');
    expect(audit).not.toContain(KEY);
    expect(h.logs.join('\n')).not.toContain(KEY);
  });

  it('isolates tenants', async () => {
    expect((await call('GET', '/settings/llm', otherAdmin, undefined, 'globex')).json()).toEqual({ configured: false });
    expect((await call('GET', '/settings/llm', otherAdmin, undefined, 'acme')).statusCode).toBe(403);
  });

  it('requires a public base URL for compatible providers and drops the key when switching providers', async () => {
    const noUrl = await call('PUT', '/settings/llm', admin, { provider: 'openai_compatible', model: 'llama' });
    expect(noUrl.statusCode).toBe(400);
    expect(noUrl.json().message).toContain('base URL');

    const r = await call('PUT', '/settings/llm', admin, { provider: 'openai_compatible', model: 'llama', baseUrl: 'https://llm.example.com/v1', jsonMode: 'object' });
    expect(r.json()).toMatchObject({ provider: 'openai_compatible', baseUrl: 'https://llm.example.com/v1', jsonMode: 'object', hasApiKey: false });
  });

  it('tests the connection with the stored or a draft configuration', async () => {
    await call('PUT', '/settings/llm', admin, { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: KEY });
    llm.reset();
    const ok = await call('POST', '/settings/llm/test', admin, {});
    expect(ok.json()).toMatchObject({ ok: true });
    expect(llm.configs[0]).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: KEY });

    llm.pingError = new ValidationError(msg('llm.invalidKey'));
    const bad = await call('POST', '/settings/llm/test', admin, { apiKey: 'sk-other-candidate-key' });
    expect(bad.json()).toMatchObject({ ok: false, error: 'the LLM provider rejected the API key' });
    expect(llm.configs[1]!.apiKey).toBe('sk-other-candidate-key');

    // a different provider never reuses the stored key
    const other = await call('POST', '/settings/llm/test', admin, { provider: 'openai', model: 'gpt-x' });
    expect(other.statusCode).toBe(400);
    expect(other.json().details).toMatchObject({ code: 'LLM_NOT_CONFIGURED' });
    expect((await call('POST', '/settings/llm/test', owner, {})).statusCode).toBe(403);
  });

  it('deletes the configuration', async () => {
    expect((await call('DELETE', '/settings/llm', admin)).statusCode).toBe(204);
    expect((await call('GET', '/settings/llm', admin)).json()).toEqual({ configured: false });
  });
});

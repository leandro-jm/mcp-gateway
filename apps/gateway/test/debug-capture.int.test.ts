import { ArtifactStore } from '@mcp-gateway/artifacts';
import { decryptJson } from '@mcp-gateway/core';
import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, startInfra, type Harness, type Infra } from './harness';
import { mcpClient, seedRhTenant, type SeededTenant } from './seed';

const callIdOf = (r: { _meta?: unknown }) => (r._meta as Record<string, string>)['io.github.leandro-jm.mcp-gateway/call-id']!;

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('debug capture (F15.17)', () => {
  let infra: Infra;
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let admin: string;
  let base: string;

  const call = (method: string, url: string, body?: unknown, token = admin) =>
    h.app.inject({ method: method as 'GET', url: `/admin/v1${url}`, headers: { authorization: `Bearer ${token}`, 'x-tenant': 'acme' }, ...(body ? { payload: body as object } : {}) });

  beforeAll(async () => {
    infra = await startInfra({ minio: true });
    h = await startHarness({ infra, env: { DEBUG_CAPTURE_ENABLED: 'true', DEBUG_CAPTURE_MAX_MINUTES: '30' } });
    up = await startFakeUpstream();
    seeded = await seedRhTenant(h, up);
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    admin = await h.adminToken('acme');
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
    await infra?.stop();
  });

  it('captures only matching calls, up to the cap, encrypted at rest', async () => {
    const created = await call('POST', '/debug-captures', { reason: 'investigating 404s', filter: { tool: 'rh_colaborador_get' }, maxCalls: 2, minutes: 10 });
    expect(created.statusCode).toBe(201);
    const capture = created.json();
    expect(capture).toMatchObject({ status: 'active', maxCalls: 2, capturedCount: 0 });

    const agent = await mcpClient(base, await h.token({ tenant: 'acme', sub: 'agent-d' }));
    const colab = up.data.colaboradores[1]!;
    const ids: string[] = [];
    try {
      for (let i = 0; i < 3; i++) ids.push(callIdOf(await agent.callTool({ name: 'rh_colaborador_get', arguments: { id: colab.id } })));
      await agent.callTool({ name: 'rh_colaboradores_list', arguments: { size: 1 } });
    } finally {
      await agent.close();
    }
    const items = await until(
      async () => (await call('GET', `/debug-captures/${capture.id}/items`)).json().items as Array<{ callId: string; tool: string }>,
      (v) => v.length >= 2,
    );
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.tool === 'rh_colaborador_get')).toBe(true);

    const raw = await call('GET', `/calls/${items[0]!.callId}/debug`);
    expect(raw.statusCode).toBe(200);
    const captured = raw.json();
    expect(captured).toMatchObject({ tool: 'rh_colaborador_get', principal: { sub: 'agent-d' }, args: { id: colab.id }, upstream: { status: 200 } });
    expect(JSON.stringify(captured.upstream.body)).toContain(colab.cpf); // raw, before redaction
    expect(JSON.stringify(captured.final)).not.toContain(colab.cpf); // what the agent got
    const [view] = await h.services.repos.audit.list(seeded.tenantId, { action: 'debug.view', limit: 1 });
    expect(view).toMatchObject({ callId: items[0]!.callId, decision: 'allow' });

    // at rest: ciphertext in MinIO, bound to tenant and call
    const store = new ArtifactStore({ endpoint: infra.minio!.endpoint, region: 'us-east-1', accessKeyId: infra.minio!.accessKey, secretAccessKey: infra.minio!.secretKey, bucket: 'mcp-artifacts' });
    const { rows } = await h.services.dbHandle.pool.query('SELECT object_key FROM debug_capture_items WHERE call_id = $1', [items[0]!.callId]);
    const text = await store.getText(rows[0].object_key);
    expect(text).not.toContain(colab.cpf);
    const key = await h.services.keyring.dataKey(seeded.tenantId);
    expect(() => decryptJson(key, text, `debug:other-tenant:${items[0]!.callId}`)).toThrow();
    expect(decryptJson<{ tool: string }>(key, text, `debug:${seeded.tenantId}:${items[0]!.callId}`).tool).toBe('rh_colaborador_get');
    store.close();
  });

  it('stops, expires and cleans up', async () => {
    const c = (await call('POST', '/debug-captures', { reason: 'short one', maxCalls: 5, minutes: 5 })).json();
    expect((await call('DELETE', `/debug-captures/${c.id}`)).json().status).toBe('stopped');
    expect((await call('POST', '/debug-captures', { reason: 'too long', minutes: 60 })).statusCode).toBe(400);

    await h.services.dbHandle.pool.query("UPDATE debug_capture_items SET expires_at = now() - interval '1 minute'");
    const removed = await h.services.debug.cleanup();
    expect(removed).toBeGreaterThan(0);
    expect((await h.services.dbHandle.pool.query('SELECT count(*)::int AS n FROM debug_capture_items')).rows[0].n).toBe(0);
    const audits = await h.services.repos.audit.list(seeded.tenantId, { action: 'debug.capture.create', limit: 10 });
    expect(audits[0]!.details).toMatchObject({ reason: expect.any(String) });
  });

  it('only gateway-admin; unavailable without the kill switch', async () => {
    const owner = await h.token({ tenant: 'acme', sub: 'owner-d', roles: ['tool-owner'], groups: ['team-rh'] });
    const reader = await h.token({ tenant: 'acme', sub: 'reader-d', roles: ['analytics-reader'] });
    expect((await call('POST', '/debug-captures', { reason: 'nope' }, owner)).statusCode).toBe(403);
    expect((await call('GET', '/debug-captures', undefined, reader)).statusCode).toBe(403);

    const off = await startHarness({ infra });
    try {
      const res = await off.app.inject({
        method: 'POST',
        url: '/admin/v1/debug-captures',
        headers: { authorization: `Bearer ${await off.adminToken('acme')}`, 'x-tenant': 'acme' },
        payload: { reason: 'disabled' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/DEBUG_CAPTURE_ENABLED/);
    } finally {
      await off.teardown();
    }
  });
});

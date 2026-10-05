import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorPayload } from '../../src/proxy/result';
import { startHarness, startInfra, type Harness, type Infra } from '../harness';
import { mcpClient, seedRhTenant, type SeededTenant } from '../seed';

/** Tenant isolation on every surface (data plane, Admin API, vaults, artifacts). */
describe('security: tenant isolation', () => {
  let infra: Infra;
  let h: Harness;
  let up: FakeUpstream;
  let a: SeededTenant;
  let b: SeededTenant;
  let base: string;
  let clientA: Client;
  let clientB: Client;

  const adminApi = async (token: string, url: string, tenant?: string, method = 'GET', body?: unknown) =>
    h.app.inject({ method: method as 'GET', url: `/admin/v1${url}`, headers: { authorization: `Bearer ${token}`, ...(tenant ? { 'x-tenant': tenant } : {}) }, ...(body ? { payload: body as object } : {}) });

  beforeAll(async () => {
    infra = await startInfra({ minio: true });
    h = await startHarness({ infra });
    up = await startFakeUpstream();
    a = await seedRhTenant(h, up, { slug: 'tenant-a' });
    b = await seedRhTenant(h, up, { slug: 'tenant-b', enable: ['rh_escalas_list'] });
    await h.services.repos.virtualServers.create(b.tenantId, { slug: 'only-b', toolSelector: { patterns: ['*'] } });
    await h.services.repos.policies.create(b.tenantId, { subjectType: 'role', subject: 'visitante', effect: 'allow', toolPattern: '*' });
    await h.services.registry.invalidate(b.tenantId);
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    clientA = await mcpClient(base, await h.token({ tenant: 'tenant-a', sub: 'same-sub', azp: 'same-client' }));
    clientB = await mcpClient(base, await h.token({ tenant: 'tenant-b', sub: 'same-sub', azp: 'same-client' }));
  }, 240_000);
  afterAll(async () => {
    await clientA?.close();
    await clientB?.close();
    await h?.teardown();
    await up?.close();
    await infra?.stop();
  });

  it("catalog and calls belong to the token's tenant", async () => {
    expect((await clientA.listTools()).tools.map((t) => t.name)).toContain('rh_colaborador_get');
    expect((await clientB.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith('rh_'))).toEqual(['rh_escalas_list']);
    await expect(clientB.callTool({ name: 'rh_colaborador_get', arguments: { id: 'col-00001' } })).rejects.toMatchObject({ code: -32602 });
  });

  it("one tenant's policies and virtual servers do not apply to another", async () => {
    const visitorA = await mcpClient(base, await h.token({ tenant: 'tenant-a', roles: ['visitante'] }));
    try {
      expect((await visitorA.listTools()).tools.filter((t) => t.name.startsWith('rh_'))).toEqual([]);
    } finally {
      await visitorA.close();
    }
    const res = await fetch(`${base}/mcp/s/only-b`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await h.token({ tenant: 'tenant-a' })}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
  });

  it('artifacts and PII tokens do not cross tenants (same sub/client)', async () => {
    const off = await clientA.callTool({ name: 'rh_colaboradores_list', arguments: { _output: 'artifact' } });
    const uri = (off.structuredContent as { artifact_uri: string }).artifact_uri;
    expect(errorPayload(await clientB.callTool({ name: 'artifact_read', arguments: { uri } }))).toMatchObject({ message: 'artifact not found or expired' });

    await h.services.repos.piiRules.create(a.tenantId, { scope: 'global', detector: 'cpf', strategy: 'tokenize' });
    await h.services.registry.invalidate(a.tenantId);
    const got = await clientA.callTool({ name: 'rh_colaborador_get', arguments: { id: up.data.colaboradores[0]!.id } });
    const token = (got.structuredContent as { cpf: string }).cpf;
    expect(token).toMatch(/^pii_tok_/);
    await h.services.repos.tools.setState(b.tenantId, b.tools.rh_marcacao_create!, 'disabled', 'enabled');
    await h.services.registry.invalidate(b.tenantId);
    const r = await clientB.callTool({
      name: 'rh_marcacao_create',
      arguments: { colaborador_id: up.data.colaboradores[0]!.id, cpf: token, data_hora: '2026-10-01T08:00:00-03:00', tipo: 'entrada' },
    });
    expect(errorPayload(r)).toMatchObject({ message: 'invalid or expired PII token' });
  });

  it('Admin API: owners cannot access another tenant; resources by id do not leak across tenants', async () => {
    const ownerA = await h.token({ roles: ['tool-owner'], tenant: 'tenant-a', groups: ['team-rh'] });
    expect((await adminApi(ownerA, '/tools', 'tenant-b')).statusCode).toBe(403);
    const adminA = await h.adminToken('tenant-a');
    // gateway-admin picks the tenant explicitly; B's ids don't resolve in A's context
    expect((await adminApi(adminA, `/tools/${b.tools.rh_escalas_list}`, 'tenant-a')).statusCode).toBe(404);
    expect((await adminApi(adminA, `/sources/${b.sourceId}`, 'tenant-a')).statusCode).toBe(404);
    expect((await adminApi(adminA, `/credentials/${b.credentialId}`, 'tenant-a')).statusCode).toBe(404);
    expect((await adminApi(adminA, `/tools/${b.tools.rh_escalas_list}/enable`, 'tenant-a', 'POST')).statusCode).toBe(404);
    const auditA = (await adminApi(adminA, '/audit?limit=500', 'tenant-a')).json();
    expect(auditA.items.every((e: { toolId: string | null }) => !Object.values(b.tools).includes(e.toolId ?? ''))).toBe(true);
  });

  it('registry snapshots are separate per tenant', async () => {
    const [sa, sb] = await Promise.all([h.services.registry.get(a.tenantId), h.services.registry.get(b.tenantId)]);
    const idsA = new Set(sa.tools.map((t) => t.id));
    expect(sb.tools.some((t) => idsA.has(t.id))).toBe(false);
    expect(sb.sources.map((s) => s.id)).toEqual([b.sourceId]);
  });

  it('observability surfaces (F15) do not cross tenants', async () => {
    const callA = await clientA.callTool({ name: 'rh_colaboradores_list', arguments: { size: 1 } });
    const callB = await clientB.callTool({ name: 'rh_escalas_list', arguments: {} });
    const idA = (callA._meta as Record<string, string>)['io.github.leandro-jm.mcp-gateway/call-id']!;
    const idB = (callB._meta as Record<string, string>)['io.github.leandro-jm.mcp-gateway/call-id']!;
    await h.services.callEvents.flush();
    await h.services.repos.rollups.rollup();
    const adminA = await h.adminToken('tenant-a');

    // analytics counts only tenant A
    const q = await adminApi(adminA, '/analytics/query', 'tenant-a', 'POST', { metric: 'calls', groupBy: ['tool'], range: { last: '1h' } });
    const rawA = (await h.services.dbHandle.pool.query("SELECT count(*)::int AS n FROM call_events WHERE tenant_id = $1 AND kind = 'tool'", [a.tenantId])).rows[0].n;
    expect(q.json().rows.reduce((acc: number, r: { value: number }) => acc + r.value, 0)).toBe(rawA);

    // B's call is invisible from A (explorer, debug, replay)
    expect((await adminApi(adminA, `/calls/${idB}`, 'tenant-a')).statusCode).toBe(404);
    expect((await adminApi(adminA, `/calls/${idB}/debug`, 'tenant-a')).statusCode).toBe(404);
    expect((await adminApi(adminA, `/calls/${idB}/replay`, 'tenant-a', 'POST')).statusCode).toBe(404);
    expect((await adminApi(adminA, '/calls?limit=200', 'tenant-a')).json().items.some((c: { callId: string }) => c.callId === idB)).toBe(false);
    expect((await adminApi(adminA, `/calls/${idA}`, 'tenant-a')).statusCode).toBe(200);

    // a tenant admin cannot point any new route at tenant B
    for (const [method, url, body] of [
      ['GET', '/analytics/sre'],
      ['GET', '/analytics/finops'],
      ['GET', '/calls'],
      ['GET', '/sessions'],
      ['GET', '/agent-insights/findings'],
      ['GET', '/debug-captures'],
      ['GET', '/settings/observability'],
      ['POST', '/analytics/query', { metric: 'calls', range: { last: '1h' } }],
      ['POST', '/lgpd/subject-access', { detector: 'cpf', value: up.data.colaboradores[0]!.cpf }],
    ] as Array<[string, string, unknown?]>) {
      expect((await adminApi(adminA, url, 'tenant-b', method, body)).statusCode, `${method} ${url}`).toBe(403);
    }

    // the observability MCP of A cannot explain B's calls
    const readerA = await mcpClient(base, await h.token({ tenant: 'tenant-a', sub: 'reader-a', roles: ['analytics-reader'] }), '/mcp/observability');
    try {
      const r = await readerA.callTool({ name: 'explain_call', arguments: { call_id: idB } });
      expect(r.isError).toBe(true);
      expect(errorPayload(r)).toMatchObject({ error: 'NOT_FOUND' });
    } finally {
      await readerA.close();
    }

    // report_outcome rejects call ids of another tenant
    const outcome = await h.app.inject({
      method: 'POST',
      url: '/v1/outcomes',
      headers: { authorization: `Bearer ${await h.token({ tenant: 'tenant-b', sub: 'same-sub', azp: 'same-client' })}` },
      payload: { outcome: 'success', call_ids: [idA] },
    });
    expect(outcome.statusCode).toBe(400);
  });
});

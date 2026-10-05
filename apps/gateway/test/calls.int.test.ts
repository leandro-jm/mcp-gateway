import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness';
import { mcpClient, seedRhTenant, type SeededTenant } from './seed';

const callIdOf = (r: { _meta?: unknown }) => (r._meta as Record<string, string>)['io.github.leandro-jm.mcp-gateway/call-id']!;

describe('call explorer and explain (F15.13)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let admin: string;
  let agent: Client;

  const get = (url: string, token = admin, tenant = 'acme') =>
    h.app.inject({ method: 'GET', url: `/admin/v1${url}`, headers: { authorization: `Bearer ${token}`, 'x-tenant': tenant } });

  beforeAll(async () => {
    h = await startHarness({ env: { TRACE_UI_URL_TEMPLATE: 'http://jaeger.test/trace/{traceId}' } });
    up = await startFakeUpstream();
    seeded = await seedRhTenant(h, up);
    await seedRhTenant(h, up, { slug: 'other' });
    await h.services.repos.projections.upsert(seeded.tenantId, seeded.tools.rh_colaboradores_list!, { include: ['$.items[*].id'] });
    await h.services.registry.invalidate(seeded.tenantId);
    const base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    agent = await mcpClient(base, await h.token({ tenant: 'acme', sub: 'agent-c' }));
    admin = await h.adminToken('acme');
  });
  afterAll(async () => {
    await agent?.close();
    await h?.teardown();
    await up?.close();
  });

  it('lists calls newest first with filters and a cursor', async () => {
    for (let i = 0; i < 3; i++) await agent.callTool({ name: 'rh_colaboradores_list', arguments: { size: 5 } });
    await agent.callTool({ name: 'rh_colaborador_get', arguments: { id: 'missing' } });
    await h.services.callEvents.flush();
    const all = (await get('/calls?kind=tool&limit=2')).json();
    expect(all.items).toHaveLength(2);
    expect(all.items[0].tool.name).toBe('rh_colaborador_get');
    expect(all.nextCursor).toEqual(expect.any(String));
    const page2 = (await get(`/calls?kind=tool&limit=2&cursor=${all.nextCursor}`)).json();
    expect(page2.items.map((c: { tool: { name: string } }) => c.tool.name)).toEqual(['rh_colaboradores_list', 'rh_colaboradores_list']);
    const errors = (await get('/calls?decision=error')).json();
    expect(errors.items).toHaveLength(1);
    expect(errors.items[0]).toMatchObject({ error: { code: 'UPSTREAM_CLIENT_ERROR', stage: 'upstream' }, upstream: { status: 404 } });
    expect((await get('/calls?cursor=bad')).statusCode).toBe(400);
  });

  it('explains a call: stages, rule, projection cut, tokens, audit and trace link', async () => {
    const r = await agent.callTool({ name: 'rh_colaboradores_list', arguments: { size: 20 } });
    await h.services.callEvents.flush();
    const res = await get(`/calls/${callIdOf(r)}`);
    expect(res.statusCode).toBe(200);
    const e = res.json();
    expect(e.call).toMatchObject({ callId: callIdOf(r), decision: 'allow', tool: { name: 'rh_colaboradores_list' } });
    expect(e.stages.map((s: { stage: string }) => s.stage)).toEqual(expect.arrayContaining(['authz', 'upstream', 'projection', 'overhead']));
    expect(e.policy).toMatchObject({ decision: 'allow', ruleId: expect.any(String), policyChanged: false, current: { effect: 'allow' } });
    expect(e.data.projection.cutPct).toBeGreaterThan(0);
    expect(e.data.redactionsByDetector.cpf).toBe(20); // redaction runs on the full body, before projection
    expect(e.tokens.savedProjection).toBeGreaterThan(0);
    expect(e.audit).toMatchObject({ action: 'tools/call', decision: 'allow' });
    expect(e.traceUrl).toBe(`http://jaeger.test/trace/${e.call.traceId}`);
  });

  it('flags a decision that no longer holds after a policy change', async () => {
    const r = await agent.callTool({ name: 'rh_colaborador_get', arguments: { id: up.data.colaboradores[0]!.id } });
    await h.services.callEvents.flush();
    await h.services.repos.policies.create(seeded.tenantId, { subjectType: 'user', subject: 'agent-c', effect: 'deny', toolPattern: 'rh_colaborador_get' });
    await h.services.registry.invalidate(seeded.tenantId);
    const e = (await get(`/calls/${callIdOf(r)}`)).json();
    expect(e.policy).toMatchObject({ decision: 'allow', policyChanged: true, current: { effect: 'deny', reason: 'explicit_deny' } });

    const denied = await agent.callTool({ name: 'rh_colaborador_get', arguments: { id: 'x' } }).catch((err: Error) => err);
    expect(denied).toBeInstanceOf(Error);
    await h.services.callEvents.flush();
    const [deny] = (await get('/calls?decision=deny')).json().items;
    const d = (await get(`/calls/${deny.callId}`)).json();
    expect(d.policy).toMatchObject({ decision: 'deny', reason: 'explicit_deny', ruleId: expect.any(String), policyChanged: false });
    expect(d.policy.trace.some((t: { matched: boolean; effect: string }) => t.matched && t.effect === 'deny')).toBe(true);
  });

  it('is tenant-scoped and restricted for owners and agents', async () => {
    const [any] = (await get('/calls?limit=1')).json().items;
    expect((await get(`/calls/${any.callId}`, await h.adminToken('other'), 'other')).statusCode).toBe(404);
    expect((await get('/calls/0192f2a4-0000-7000-8000-000000000000')).statusCode).toBe(404);
    expect((await get('/calls', await h.token({ tenant: 'acme' }))).statusCode).toBe(403);
    const ownerX = await h.token({ tenant: 'acme', sub: 'owner-x', roles: ['tool-owner'], groups: ['team-x'] });
    expect((await get('/calls', ownerX)).json().items).toEqual([]);
    expect((await get(`/calls/${any.callId}`, ownerX)).statusCode).toBe(403);
    const ownerRh = await h.token({ tenant: 'acme', sub: 'owner-rh', roles: ['tool-owner'], groups: ['team-rh'] });
    expect((await get(`/calls/${any.callId}`, ownerRh)).statusCode).toBe(200);
  });
});

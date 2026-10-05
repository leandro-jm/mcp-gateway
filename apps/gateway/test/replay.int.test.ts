import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, startInfra, type Harness, type Infra } from './harness';
import { mcpClient, seedRhTenant, type SeededTenant } from './seed';

const callIdOf = (r: { _meta?: unknown }) => (r._meta as Record<string, string>)['io.github.leandro-jm.mcp-gateway/call-id']!;

const RESUMO = `
name: rh_resumo_replay
description: Colaborador e escalas
input:
  type: object
  required: [colaborador_id]
  properties:
    colaborador_id: { type: string }
steps:
  - id: colab
    tool: rh_colaborador_get
    args: { id: "$input.colaborador_id" }
  - id: escalas
    tool: rh_escalas_list
    args: { colaborador: "$steps.colab.id" }
output: |
  { "nome": $steps.colab.nome, "cpf": $steps.colab.cpf, "escalas": $count($steps.escalas) }
`;

describe('replay-mock (F15.18)', () => {
  let infra: Infra;
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let admin: string;
  let agent: Client;

  const call = (method: string, url: string, body?: unknown) =>
    h.app.inject({ method: method as 'GET', url: `/admin/v1${url}`, headers: { authorization: `Bearer ${admin}`, 'x-tenant': 'acme' }, ...(body ? { payload: body as object } : {}) });

  async function captured(callId: string) {
    for (let i = 0; i < 100; i++) {
      if ((await call('GET', `/calls/${callId}/debug`)).statusCode === 200) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('not captured');
  }

  beforeAll(async () => {
    infra = await startInfra({ minio: true });
    h = await startHarness({ infra, env: { DEBUG_CAPTURE_ENABLED: 'true' } });
    up = await startFakeUpstream();
    seeded = await seedRhTenant(h, up);
    admin = await h.adminToken('acme');
    const base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    agent = await mcpClient(base, await h.token({ tenant: 'acme', sub: 'agent-r' }));
    expect((await call('POST', '/debug-captures', { reason: 'replay tests', maxCalls: 50, minutes: 30 })).statusCode).toBe(201);
  });
  afterAll(async () => {
    await agent?.close();
    await h?.teardown();
    await up?.close();
    await infra?.stop();
  });

  it('reflects a new projection without calling the upstream again', async () => {
    const callId = callIdOf(await agent.callTool({ name: 'rh_colaboradores_list', arguments: { size: 20 } }));
    await captured(callId);
    await h.services.callEvents.flush();
    await h.services.repos.projections.upsert(seeded.tenantId, seeded.tools.rh_colaboradores_list!, { include: ['$.items[*].id'] });
    await h.services.registry.invalidate(seeded.tenantId);

    const upstreamBefore = up.requests.length;
    const eventsBefore = (await h.services.dbHandle.pool.query('SELECT count(*)::int AS n FROM call_events')).rows[0].n;
    const res = await call('POST', `/calls/${callId}/replay`);
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(up.requests.length).toBe(upstreamBefore);
    expect(r.original.decision).toBe('allow');
    expect(r.replayed.decision).toBe('allow');
    expect(r.deltas.responseBytes).toBeLessThan(0);
    expect(r.replayed.bytesAfterProjection).toBeLessThan(r.replayed.bytesBeforeProjection);
    expect(JSON.stringify(r.replayed.final)).not.toContain('"nome"');

    await h.services.callEvents.flush();
    expect((await h.services.dbHandle.pool.query('SELECT count(*)::int AS n FROM call_events')).rows[0].n).toBe(eventsBefore);
    const [audit] = await h.services.repos.audit.list(seeded.tenantId, { action: 'tools/replay', limit: 1 });
    expect(audit).toMatchObject({ decision: 'allow', toolName: 'rh_colaboradores_list', details: { replayOf: callId } });
  });

  it('shows a decision change after a policy change', async () => {
    const callId = callIdOf(await agent.callTool({ name: 'rh_colaborador_get', arguments: { id: up.data.colaboradores[0]!.id } }));
    await captured(callId);
    const policy = await h.services.repos.policies.create(seeded.tenantId, { subjectType: 'user', subject: 'agent-r', effect: 'deny', toolPattern: 'rh_colaborador_get' });
    await h.services.registry.invalidate(seeded.tenantId);
    try {
      const r = (await call('POST', `/calls/${callId}/replay`)).json();
      expect(r.deltas.decisionChanged).toBe(true);
      expect(r.replayed.decision).toBe('deny');
    } finally {
      await h.services.repos.policies.delete(seeded.tenantId, policy.id);
      await h.services.registry.invalidate(seeded.tenantId);
    }
  });

  it('replays a composite from its recorded steps', async () => {
    const created = await call('POST', '/composites', { source: RESUMO });
    expect(created.statusCode).toBe(201);
    await call('POST', `/tools/${created.json().toolId}/enable`);
    const callId = callIdOf(await agent.callTool({ name: 'rh_resumo_replay', arguments: { colaborador_id: up.data.colaboradores[2]!.id } }));
    await captured(callId);
    const debug = (await call('GET', `/calls/${callId}/debug`)).json();
    expect(debug.steps.map((s: { tool: string }) => s.tool).sort()).toEqual(['rh_colaborador_get', 'rh_escalas_list']);
    const upstreamBefore = up.requests.length;
    const r = (await call('POST', `/calls/${callId}/replay`)).json();
    expect(up.requests.length).toBe(upstreamBefore);
    expect(r.replayed.decision).toBe('allow');
    expect(r.replayed.final.structuredContent ?? JSON.parse(r.replayed.final.content[0].text)).toMatchObject({ nome: up.data.colaboradores[2]!.nome });
  });

  it('unknown or uncaptured calls are 404', async () => {
    expect((await call('POST', '/calls/0192f2a4-0000-7000-8000-000000000000/replay')).statusCode).toBe(404);
  });
});

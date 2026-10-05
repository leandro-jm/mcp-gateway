import { findValueMatches } from '@mcp-gateway/redaction';
import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness';
import { mcpClient, seedRhTenant, type SeededTenant } from './seed';

const RESUMO = `
name: rh_resumo_ce
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
  { "nome": $steps.colab.nome, "cpf": $steps.colab.cpf, "escala": $steps.escalas[0].nome }
`;

type Row = Record<string, any>;

describe('wide call events (F15.7)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let base: string;
  let agent: Client;

  const rows = async (where = 'true', params: unknown[] = []): Promise<Row[]> => {
    await h.services.callEvents.flush();
    return (await h.services.dbHandle.pool.query(`SELECT * FROM call_events WHERE ${where} ORDER BY ts`, params)).rows;
  };

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    seeded = await seedRhTenant(h, up);
    await h.services.repos.projections.upsert(seeded.tenantId, seeded.tools.rh_colaboradores_list!, { include: ['$.items[*].id', '$.total'] });
    await h.services.registry.invalidate(seeded.tenantId);
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    // PII in subject and client: must not reach call_events in clear
    agent = await mcpClient(base, await h.token({ tenant: 'acme', sub: 'ana.souza@empresa.com', azp: 'bot-529.982.247-25' }));
  });
  afterAll(async () => {
    await agent?.close();
    await h?.teardown();
    await up?.close();
  });

  it('one call gives exactly one event with identity, stages, policy rule, bytes and tokens', async () => {
    const res = await agent.callTool({ name: 'rh_colaboradores_list', arguments: { size: 20 } });
    const callId = (res._meta as Record<string, string>)['io.github.leandro-jm.mcp-gateway/call-id'];
    const evs = await rows('call_id = $1', [callId]);
    expect(evs).toHaveLength(1);
    const ev = evs[0]!;
    expect(ev).toMatchObject({
      kind: 'tool',
      endpoint: 'mcp',
      tool_name: 'rh_colaboradores_list',
      tool_kind: 'openapi',
      tool_id: seeded.tools.rh_colaboradores_list,
      source_id: seeded.sourceId,
      decision: 'allow',
      upstream_status: 200,
      attempts: 1,
      agent_name: 'test',
      session_source: 'header',
      policy_reason: 'allow',
      policy_rule_id: expect.any(String),
      policy_trace: null,
      plugins: null,
      gate: null,
      taint: null,
      pinned_version: null,
    });
    expect(ev.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(ev.args_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(ev.policy_version).toMatch(/^[0-9a-f]{16}$/);
    const stages = ['authz_ms', 'validation_ms', 'pii_ms', 'upstream_ms', 'projection_ms'].map((k) => ev[k] as number);
    expect(stages.every((n) => typeof n === 'number' && n >= 0)).toBe(true);
    expect(stages.reduce((a, n) => a + n, 0)).toBeLessThanOrEqual(ev.latency_ms + 5);
    expect(ev.overhead_ms).toBe(Math.max(0, ev.latency_ms - ev.upstream_ms));
    expect(ev.bytes_before_projection).toBeGreaterThan(ev.bytes_after_projection);
    expect(ev.tokens_saved_projection).toBeGreaterThan(0);
    expect(ev.def_tokens).toBeGreaterThan(0);
    expect(ev.response_tokens).toBeGreaterThan(0);
    // the audit row still exists and now keeps the allow rule
    const [audit] = await h.services.repos.audit.list(seeded.tenantId, { toolId: seeded.tools.rh_colaboradores_list, limit: 1 });
    expect(audit).toMatchObject({ callId, decision: 'allow', details: { ruleId: ev.policy_rule_id } });
  });

  it('the same arguments give the same args_hash (loop detection), different ones do not', async () => {
    const id = up.data.colaboradores[0]!.id;
    for (const args of [{ id }, { id }, { id: up.data.colaboradores[1]!.id }]) await agent.callTool({ name: 'rh_colaborador_get', arguments: args });
    const evs = await rows("tool_name = 'rh_colaborador_get'");
    const hashes = evs.slice(-3).map((e) => e.args_hash);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
  });

  it('a deny keeps the reason and the rule trace (message keys only); errors keep code and stage', async () => {
    const outsider = await mcpClient(base, await h.token({ tenant: 'acme', sub: 'outsider', roles: ['viewer'] }));
    try {
      await outsider.callTool({ name: 'rh_colaborador_get', arguments: { id: 'x' } }).catch(() => undefined);
    } finally {
      await outsider.close();
    }
    const [deny] = await rows("subject = 'outsider'");
    expect(deny).toMatchObject({ decision: 'deny', policy_reason: 'default_deny', error_code: 'TOOL_NOT_FOUND', error_stage: 'protocol' });
    expect(Array.isArray(deny!.policy_trace)).toBe(true);
    for (const t of deny!.policy_trace) expect(Object.keys(t).sort()).toEqual(['effect', 'matched', 'note', 'ruleId']);

    await agent.callTool({ name: 'rh_colaborador_get', arguments: { id: 'does-not-exist' } });
    const notFound = (await rows("tool_name = 'rh_colaborador_get' AND decision = 'error'")).at(-1)!;
    expect(notFound).toMatchObject({ upstream_status: 404, error_code: 'UPSTREAM_CLIENT_ERROR', error_stage: 'upstream' });

    await agent.callTool({ name: 'rh_colaborador_get', arguments: { nope: 1 } });
    const invalid = (await rows("error_code = 'VALIDATION_ERROR'")).at(-1)!;
    expect(invalid).toMatchObject({ decision: 'error', error_stage: 'validation', error_key: expect.stringMatching(/^proxy\./) });
  });

  it('a composite gives a parent event and one child per step, linked by parent_call_id', async () => {
    const admin = await h.adminToken('acme');
    const created = await h.app.inject({
      method: 'POST',
      url: '/admin/v1/composites',
      headers: { authorization: `Bearer ${admin}`, 'x-tenant': 'acme' },
      payload: { source: RESUMO },
    });
    expect(created.statusCode).toBe(201);
    const toolId = created.json().toolId;
    await h.app.inject({ method: 'POST', url: `/admin/v1/tools/${toolId}/enable`, headers: { authorization: `Bearer ${admin}`, 'x-tenant': 'acme' } });
    const res = await agent.callTool({ name: 'rh_resumo_ce', arguments: { colaborador_id: up.data.colaboradores[2]!.id } });
    expect(res.isError).toBeFalsy();
    const callId = (res._meta as Record<string, string>)['io.github.leandro-jm.mcp-gateway/call-id'];
    const [parent] = await rows('call_id = $1', [callId]);
    expect(parent).toMatchObject({ kind: 'tool', tool_kind: 'composite', decision: 'allow' });
    expect(parent!.redactions_count).toBeGreaterThan(0);
    const children = await rows('parent_call_id = $1', [callId]);
    expect(children.map((c) => c.tool_name).sort()).toEqual(['rh_colaborador_get', 'rh_escalas_list']);
    expect(children.every((c) => c.kind === 'composite_step' && c.upstream_status === 200 && c.trace_id === parent!.trace_id)).toBe(true);
  });

  it('Omni records search (names only, never the query), schema lookups and list events with catalog tokens', async () => {
    const omni = await mcpClient(base, await h.token({ tenant: 'acme', sub: 'omni-user' }), '/mcp/omni');
    try {
      await omni.listTools();
      await omni.callTool({ name: 'search_tools', arguments: { query: 'listar colaboradores 529.982.247-25' } });
      await omni.callTool({ name: 'get_tool_schema', arguments: { name: 'rh_colaboradores_list' } });
      await omni.callTool({ name: 'call_tool', arguments: { name: 'rh_colaboradores_list', arguments: { size: 1 } } });
    } finally {
      await omni.close();
    }
    const evs = await rows("subject = 'omni-user'");
    const byKind = (k: string) => evs.filter((e) => e.kind === k);
    const list = byKind('list')[0]!;
    expect(list).toMatchObject({ endpoint: 'omni', tool_name: 'tools/list', via_omni: true });
    expect(list.meta.fullCatalogTokens).toBeGreaterThan(list.catalog_tokens);
    const [search, schema] = byKind('meta');
    expect(search).toMatchObject({ tool_name: 'search_tools', tool_kind: 'meta', decision: 'allow' });
    expect(search!.meta.results).toContain('rh_colaboradores_list');
    expect(search!.meta.queryHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(search)).not.toContain('listar colaboradores');
    expect(schema!.meta).toEqual({ tool: 'rh_colaboradores_list' });
    expect(byKind('tool')[0]).toMatchObject({ tool_name: 'rh_colaboradores_list', via_omni: true, endpoint: 'omni' });
    // the native endpoint also records tools/list
    await agent.listTools();
    const [nativeList] = await rows("kind = 'list' AND endpoint = 'mcp'");
    expect(nativeList!.catalog_tokens).toBeGreaterThan(list.catalog_tokens);
  });

  it('no call_events field holds clear-text PII (scan with the F5 detectors)', async () => {
    const colab = up.data.colaboradores[0]!;
    await agent.callTool({ name: 'rh_colaborador_get', arguments: { id: colab.cpf } }); // 404 with a CPF in the path
    await agent.callTool({ name: 'rh_colaboradores_list', arguments: { nome: colab.email } });
    const all = await rows();
    expect(all.length).toBeGreaterThan(5);
    const dump = JSON.stringify(all);
    const leaks = findValueMatches(dump).filter((m) => ['cpf', 'cnpj', 'pis', 'email', 'telefone', 'cartao'].includes(m.detector.id));
    expect(leaks.map((l) => `${l.detector.id}:${l.text}`)).toEqual([]);
    for (const c of up.data.colaboradores.slice(0, 3)) {
      expect(dump).not.toContain(c.cpf);
      expect(dump).not.toContain(c.email);
    }
    expect(new Set(all.filter((r) => r.kind === 'tool' && r.subject.includes('@')).map((r) => r.subject))).toEqual(new Set(['a***@e***.com']));
  });
});

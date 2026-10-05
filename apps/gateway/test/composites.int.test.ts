import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorPayload } from '../src/proxy/result';
import { startHarness, type Harness } from './harness';
import { mcpClient, seedRhTenant, type SeededTenant } from './seed';

const RESUMO = `
name: rh_resumo_colaborador
title: Resumo do colaborador
description: Dados do colaborador, escala atual e últimas marcações
input:
  type: object
  required: [colaborador_id]
  properties:
    colaborador_id: { type: string }
    desde: { type: string, format: date }
steps:
  - id: colab
    tool: rh_colaborador_get
    args: { id: "$input.colaborador_id" }
  - id: escalas
    tool: rh_escalas_list
    args: { colaborador: "$steps.colab.id" }
  - id: marcacoes
    tool: rh_marcacoes_list
    args: { colaborador: "$steps.colab.id", desde: "$input.desde" }
    when: "$exists($input.desde)"
output: |
  {
    "nome": $steps.colab.nome,
    "cpf": $steps.colab.cpf,
    "escala_atual": $steps.escalas[0].nome,
    "ultimas_marcacoes": $steps.marcacoes[[0..2]].tipo
  }
failure_mode: partial
timeout_ms: 8000
`;

describe('composite tools (F7b.2–F7b.5)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let base: string;
  let owner: string;
  let admin: string;
  let agent: Client;
  let compositeId: string;
  let compositeToolId: string;

  const call = (method: string, url: string, body?: unknown, token = owner) =>
    h.app.inject({ method: method as 'GET', url: `/admin/v1${url}`, headers: { authorization: `Bearer ${token}`, 'x-tenant': 'acme' }, ...(body ? { payload: body as object } : {}) });

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    seeded = await seedRhTenant(h, up);
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    owner = await h.token({ roles: ['tool-owner'], tenant: 'acme', groups: ['team-rh'], sub: 'owner-1' });
    admin = await h.adminToken('acme');
    agent = await mcpClient(base, await h.token({ tenant: 'acme', sub: 'agent-1' }));
  });
  afterAll(async () => {
    await agent?.close();
    await h?.teardown();
    await up?.close();
  });

  it('an owner creates the composite (YAML): validated, disabled, with inherited annotations', async () => {
    const v = (await call('POST', '/composites/validate', { source: RESUMO })).json();
    expect(v).toMatchObject({ valid: true, levels: [['colab'], ['escalas', 'marcacoes']] });
    expect(v.dependsOn.sort()).toEqual(['rh_colaborador_get', 'rh_escalas_list', 'rh_marcacoes_list']);

    const res = await call('POST', '/composites', { source: RESUMO });
    expect(res.statusCode).toBe(201);
    const c = res.json();
    expect(c).toMatchObject({ name: 'rh_resumo_colaborador', status: 'valid', state: 'disabled', version: 1 });
    expect(c.source).toContain('rh_colaborador_get');
    compositeId = c.id;
    compositeToolId = c.toolId;
    const tool = (await call('GET', `/tools/${c.toolId}`)).json();
    expect(tool).toMatchObject({ kind: 'composite', annotations: { readOnlyHint: true }, ownerTeam: 'team-rh' });
    expect((await call('POST', `/tools/${c.toolId}/enable`)).statusCode).toBe(200);
  });

  it('an agent calls the composite: parallel steps, PII redacted only in the final output, linked audit', async () => {
    const colab = up.data.colaboradores[4]!;
    const r = await agent.callTool({ name: 'rh_resumo_colaborador', arguments: { colaborador_id: colab.id, desde: '2026-09-01' } });
    expect(r.isError).toBeFalsy();
    const out = JSON.parse((r.content as Array<{ text: string }>)[0]!.text);
    expect(out).toMatchObject({ nome: colab.nome, escala_atual: expect.any(String) });
    expect(out.cpf).toMatch(/^\*\*\*\./);
    expect(out.ultimas_marcacoes.length).toBeGreaterThan(0);

    const [parent] = await h.services.repos.audit.list(seeded.tenantId, { toolId: compositeToolId, limit: 1 });
    expect(parent).toMatchObject({ action: 'tools/call', decision: 'allow', details: { calls: 3 } });
    const children = (await h.services.repos.audit.list(seeded.tenantId, { action: 'composite.step', limit: 20 })).filter((e) => e.parentCallId === parent!.callId);
    expect(children.map((e) => (e.details as any).step).sort()).toEqual(['colab', 'escalas', 'marcacoes']);
  });

  it('validates the definition: a cycle/unknown tool becomes status invalid and cannot be enabled', async () => {
    const bad = RESUMO.replace('name: rh_resumo_colaborador', 'name: rh_resumo_quebrado').replace('tool: rh_escalas_list', 'tool: rh_nao_existe');
    const c = (await call('POST', '/composites', { source: bad })).json();
    expect(c.status).toBe('invalid');
    expect(c.validationErrors[0].message).toContain('unknown tool: rh_nao_existe');
    const en = await call('POST', `/tools/${c.toolId}/enable`);
    expect(en.statusCode).toBe(400);
    expect(en.json().message).toBe('an invalid composite cannot be enabled; fix the definition');
    expect(en.json().details[0].message).toContain('unknown tool: rh_nao_existe');
    // issues are rendered in the caller's locale
    const ownerPt = await h.token({ roles: ['tool-owner'], tenant: 'acme', groups: ['team-rh'], sub: 'owner-pt', locale: 'pt-BR' });
    const pt = (await call('GET', `/composites/${c.id}`, undefined, ownerPt)).json();
    expect(pt.validationErrors[0].message).toContain('tool inexistente: rh_nao_existe');
    const vPt = (await call('POST', '/composites/validate', { source: bad }, ownerPt)).json();
    expect(vPt.valid).toBe(false);
    expect(vPt.errors[0].message).toContain('tool inexistente: rh_nao_existe');
    expect((await call('POST', '/composites', { source: 'name: X\nsteps: []' })).statusCode).toBe(400);
  });

  it("per-step authz with the caller's identity: no permission on a step → Forbidden naming the step", async () => {
    await h.services.repos.policies.create(seeded.tenantId, { subjectType: 'role', subject: 'gestor', effect: 'allow', toolPattern: 'rh_resumo_colaborador' });
    await h.services.repos.policies.create(seeded.tenantId, { subjectType: 'role', subject: 'gestor', effect: 'allow', toolPattern: 'rh_colaborador_get' });
    await h.services.repos.policies.create(seeded.tenantId, { subjectType: 'role', subject: 'gestor', effect: 'allow', toolPattern: 'rh_marcacoes_list' });
    await h.services.registry.invalidate(seeded.tenantId);
    const gestor = await mcpClient(base, await h.token({ tenant: 'acme', roles: ['gestor'], sub: 'gestor-1' }));
    try {
      expect((await gestor.listTools()).tools.map((t) => t.name)).toContain('rh_resumo_colaborador');
      const r = await gestor.callTool({ name: 'rh_resumo_colaborador', arguments: { colaborador_id: up.data.colaboradores[0]!.id } });
      expect(errorPayload(r)).toMatchObject({ error: 'FORBIDDEN', details: { step: 'escalas', tool: 'rh_escalas_list' } });
    } finally {
      await gestor.close();
    }
  });

  it('call limit per execution (fan-out)', async () => {
    const FANOUT = `
name: rh_escalas_fanout
description: Escala de vários colaboradores
input: { type: object, properties: { ids: { type: array, items: { type: string } } } }
steps:
  - id: escalas
    tool: rh_escalas_list
    args: { colaborador: "$item" }
    foreach: { items: "$input.ids", concurrency: 3, max_items: 50 }
output: "$steps.escalas"
`;
    const c = (await call('POST', '/composites', { source: FANOUT })).json();
    await call('POST', `/tools/${c.toolId}/enable`);
    const ids = up.data.colaboradores.slice(0, 5).map((x) => x.id);
    const ok = await agent.callTool({ name: 'rh_escalas_fanout', arguments: { ids } });
    expect(ok.isError).toBeFalsy();
    await h.services.repos.tenants.update(seeded.tenantId, { settings: { composition: { maxCalls: 3 } } });
    await h.services.registry.invalidate(seeded.tenantId);
    const limited = await agent.callTool({ name: 'rh_escalas_fanout', arguments: { ids } });
    expect(errorPayload(limited)).toMatchObject({ error: 'UPSTREAM_ERROR', details: { code: 'LIMIT_CALLS' } });
    await h.services.repos.tenants.update(seeded.tenantId, { settings: {} });
    await h.services.registry.invalidate(seeded.tenantId);
  });

  it('a composite with a destructive step inherits destructiveHint and requires an explicit allow', async () => {
    const DEL = `
name: rh_desfazer_marcacao
description: Remove uma marcação e lista as restantes
input: { type: object, required: [id, colaborador], properties: { id: { type: string }, colaborador: { type: string } } }
steps:
  - id: del
    tool: rh_marcacao_delete
    args: { id: "$input.id" }
  - id: lista
    tool: rh_marcacoes_list
    args: { colaborador: "$input.colaborador" }
    when: "true"
`;
    const c = (await call('POST', '/composites', { source: DEL })).json();
    expect((await call('GET', `/tools/${c.toolId}`)).json().annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    await call('POST', `/tools/${c.toolId}/enable`);
    // seed: role agent has allow '*' and 'rh_marcacao_*' — '*' does not cover the destructive composite
    expect((await agent.listTools()).tools.map((t) => t.name)).not.toContain('rh_desfazer_marcacao');
  });

  it('dry-run: raw only for gateway-admin; writes require allowWrites', async () => {
    const colab = up.data.colaboradores[2]!;
    const agentSubject = { roles: ['agent'], sub: 'simulated' };
    const asAdmin = (await call('POST', `/composites/${compositeId}/dry-run`, { input: { colaborador_id: colab.id }, subject: agentSubject }, admin)).json();
    expect(asAdmin.rawVisible).toBe(true);
    expect(asAdmin.steps.colab.value.cpf).toBe(colab.cpf);
    expect(asAdmin.steps.marcacoes.status).toBe('skipped');
    expect(asAdmin.output.cpf).toMatch(/^\*\*\*/);
    const asOwner = (await call('POST', `/composites/${compositeId}/dry-run`, { input: { colaborador_id: colab.id }, subject: agentSubject })).json();
    expect(asOwner.rawVisible).toBe(false);
    expect(asOwner.steps.colab.value.cpf).toMatch(/^\*\*\*/);
    const desfazer = (await call('GET', '/composites')).json().items.find((x: any) => x.name === 'rh_desfazer_marcacao');
    const writes = await call('POST', `/composites/${desfazer.id}/dry-run`, { input: { id: 'x', colaborador: 'y' }, subject: agentSubject });
    expect(writes.statusCode).toBe(400);
    expect(writes.json().message).toBe('the composite changes data; send allowWrites: true to run the dry-run');
    // without a subject, it runs as the caller (admin without a read policy → steps denied)
    const self = (await call('POST', `/composites/${compositeId}/dry-run`, { input: { colaborador_id: colab.id } }, admin)).json();
    expect(self.errors.colab.message).toContain('access denied at step colab');
  });

  it('disabling a base tool invalidates the composite (cascade)', async () => {
    await call('POST', `/tools/${seeded.tools.rh_escalas_list}/disable`);
    const c = (await call('GET', `/composites/${compositeId}`)).json();
    expect(c).toMatchObject({ status: 'invalid', state: 'disabled' });
    expect(c.validationErrors.at(-1).message).toContain('rh_escalas_list');
    const [ev] = await h.services.repos.drift.list(seeded.tenantId, { toolId: compositeToolId });
    expect(ev).toMatchObject({ kind: 'breaking', diff: { cascade: true } });
    await call('POST', `/tools/${seeded.tools.rh_escalas_list}/enable`);
    // a new valid version re-enables the flow
    const v2 = (await call('PUT', `/composites/${compositeId}`, { source: RESUMO })).json();
    expect(v2).toMatchObject({ status: 'valid', version: 2 });
    expect((await call('POST', `/tools/${compositeToolId}/enable`)).statusCode).toBe(200);
  });
  it('a failing step does not leak PII through its upstream error message (abort mode)', async () => {
    const source = [
      'name: rh_eco_cpf',
      'description: looks the employee up again by CPF',
      'input: { type: object, required: [id], properties: { id: { type: string } } }',
      'steps:',
      '  - id: colab',
      '    tool: rh_colaborador_get',
      '    args: { id: "$input.id" }',
      '  - id: again',
      '    tool: rh_colaborador_get',
      '    args: { id: "$steps.colab.cpf" }',
      'failure_mode: abort',
    ].join('\n');
    const comp = (await call('POST', '/composites', { source })).json();
    expect(comp.status).toBe('valid');
    expect((await call('POST', `/tools/${comp.toolId}/enable`)).statusCode).toBe(200);
    const colab = up.data.colaboradores[0]!;
    const r = await agent.callTool({ name: 'rh_eco_cpf', arguments: { id: colab.id } });
    expect(r.isError).toBe(true);
    const text = JSON.stringify(r.content);
    expect(text).toContain('não encontrado'); // the upstream message is still useful...
    expect(text).not.toContain(colab.cpf); // ...but the CPF it echoes is redacted
    expect(text).not.toContain(colab.cpf.replace(/\D/g, ''));
  });
});

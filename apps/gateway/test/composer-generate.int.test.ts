import { UpstreamError } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeLlm } from './fake-llm';
import { startHarness, type Harness } from './harness';
import { seedRhTenant, type SeededTenant } from './seed';

const RESUMO = `name: rh_resumo_colaborador
title: Resumo do colaborador
description: Dados do colaborador, escala atual e últimas marcações
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
  - id: marcacoes
    tool: rh_marcacoes_list
    args: { colaborador: "$steps.colab.id", limit: 10 }
output: |
  { "nome": $steps.colab.nome, "escala_atual": $steps.escalas[0], "ultimas_marcacoes": $steps.marcacoes }
`;

const answer = (definition_yaml: string, extra: Record<string, unknown> = {}) => ({
  output: JSON.stringify({ definition_yaml, explanation: 'Busca o colaborador e, em paralelo, escalas e marcações.', assumptions: ['id é o código do colaborador'], unsupported: null, ...extra }),
});

const PROMPT = 'Crie uma tool que traz o resumo do colaborador com escala atual e últimas marcações';

describe('natural-language composer (F14.5)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let owner: string;
  let admin: string;
  const llm = new FakeLlm();

  const call = (method: string, url: string, body?: unknown, token = owner) =>
    h.app.inject({ method: method as 'GET', url: `/admin/v1${url}`, headers: { authorization: `Bearer ${token}`, 'x-tenant': 'acme' }, ...(body ? { payload: body as object } : {}) });
  const generate = (body: Record<string, unknown>, token = owner) => call('POST', '/composites/generate', body, token);

  beforeAll(async () => {
    h = await startHarness({ llm: llm.factory });
    up = await startFakeUpstream();
    seeded = await seedRhTenant(h, up, { enable: ['rh_colaborador_get', 'rh_escalas_list'] });
    owner = await h.token({ roles: ['tool-owner'], tenant: 'acme', groups: ['team-rh'], sub: 'owner-1', locale: 'pt-BR' });
    admin = await h.adminToken('acme');
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
  });
  beforeEach(() => llm.reset());

  it('explains that the tenant has no LLM configured', async () => {
    const r = await generate({ prompt: PROMPT });
    expect(r.statusCode).toBe(400);
    expect(r.json().details).toEqual({ code: 'LLM_NOT_CONFIGURED' });
    expect(llm.requests).toHaveLength(0);
    await h.services.repos.llmSettings.upsert(seeded.tenantId, { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-test-key-1234567890' }, 'admin');
  });

  it('drafts the employee summary over the catalog: valid, with the real DAG', async () => {
    llm.answer(answer(RESUMO));
    const r = await generate({ prompt: PROMPT });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.validation).toMatchObject({ valid: true, errors: [], levels: [['colab'], ['escalas', 'marcacoes']] });
    expect(body.validation.dependsOn.sort()).toEqual(['rh_colaborador_get', 'rh_escalas_list', 'rh_marcacoes_list']);
    expect(body.validation.graph.edges).toEqual([
      { from: 'colab', to: 'escalas' },
      { from: 'colab', to: 'marcacoes' },
    ]);
    // a disabled step tool is only a warning: the publish assistant enables it later
    expect(body.validation.warnings.map((w: { message: string }) => w.message).join(' ')).toContain('rh_marcacoes_list');
    expect(body.proposal).toMatchObject({ source: RESUMO, unsupported: null, assumptions: ['id é o código do colaborador'] });
    expect(body.usage).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5', attempts: 1, inputTokens: 100, outputTokens: 50 });
    const names = body.candidates.map((c: { name: string }) => c.name);
    expect(names).toEqual(expect.arrayContaining(['rh_colaborador_get', 'rh_escalas_list', 'rh_marcacoes_list']));
    expect(body.candidates.find((c: { name: string }) => c.name === 'rh_marcacoes_list').state).toBe('disabled');

    const [req] = llm.requests;
    expect(llm.configs[0]).toMatchObject({ provider: 'anthropic', apiKey: 'sk-ant-test-key-1234567890' });
    expect(req!.context).toContain('rh_colaborador_get');
    expect(req!.user).toContain('Brazilian Portuguese');
    expect(req!.user).toContain(PROMPT);
    expect(req!.schema).toMatchObject({ required: ['definition_yaml', 'explanation', 'assumptions', 'unsupported'] });
  });

  it('never sends upstream data nor clear-text PII to the model', async () => {
    llm.answer(answer(RESUMO));
    await generate({ prompt: `${PROMPT} do colaborador de CPF 529.982.247-25` });
    const sent = JSON.stringify(llm.requests);
    expect(sent).not.toContain('529.982.247-25');
    for (const c of up.data.colaboradores.slice(0, 5)) {
      expect(sent).not.toContain(c.nome);
      expect(sent).not.toContain(c.cpf);
    }
  });

  it('feeds the validator errors back and repairs the draft', async () => {
    llm.answer(answer(RESUMO.replace('rh_escalas_list', 'rh_escalas_inexistente')), answer(RESUMO));
    const body = (await generate({ prompt: PROMPT })).json();
    expect(body.validation.valid).toBe(true);
    expect(body.usage).toMatchObject({ attempts: 2, inputTokens: 200, outputTokens: 100 });
    const repair = llm.requests[1]!.user;
    expect(repair).toContain('unknown tool: rh_escalas_inexistente');
    expect(repair).toContain('<definition>');
    // the stable prefix does not change between attempts (prompt cache)
    expect(llm.requests[1]!.system).toBe(llm.requests[0]!.system);
    expect(llm.requests[1]!.context).toBe(llm.requests[0]!.context);
  });

  it('applies the lint of generated composites (forbidden functions, taken names)', async () => {
    llm.answer(answer(RESUMO.replace('name: rh_resumo_colaborador', 'name: rh_colaborador_get').replace('$steps.marcacoes }', '$pad("", 1e9) }')), answer(RESUMO));
    const body = (await generate({ prompt: PROMPT })).json();
    expect(body.usage.attempts).toBe(2);
    expect(llm.requests[1]!.user).toContain('a tool named rh_colaborador_get already exists');
    expect(llm.requests[1]!.user).toContain('function $pad is not allowed');
  });

  it('gives up after two repairs and returns the draft with its errors (in the user locale)', async () => {
    llm.answer(answer('name: x\ndescription: d\nsteps: []'));
    const body = (await generate({ prompt: PROMPT })).json();
    expect(body.usage.attempts).toBe(3);
    expect(body.validation.valid).toBe(false);
    expect(body.validation.errors.length).toBeGreaterThan(0);
  });

  it('handles refusals, unsupported requests and garbage output', async () => {
    llm.answer({ stop: 'refusal', output: '' });
    const refused = (await generate({ prompt: PROMPT })).json();
    expect(refused.proposal.unsupported).toBe('o modelo recusou o pedido');
    expect(refused.usage.attempts).toBe(1);

    llm.answer(answer('', { unsupported: 'o catálogo não tem tools de folha de pagamento' }));
    const unsupported = (await generate({ prompt: 'calcule a folha de pagamento' })).json();
    expect(unsupported).toMatchObject({ proposal: { unsupported: 'o catálogo não tem tools de folha de pagamento' }, validation: { valid: false } });

    llm.answer({ output: 'not json' }, answer(RESUMO));
    const repaired = (await generate({ prompt: PROMPT })).json();
    expect(repaired.validation.valid).toBe(true);
    expect(llm.requests.at(-1)!.user).toContain('not a valid proposal');
  });

  it('refines a previous draft, keeping its tools in the catalog', async () => {
    llm.answer(answer(RESUMO));
    await generate({ prompt: PROMPT, previous: RESUMO, refinement: 'inclua também o banco de horas', tools: ['rh_colaboradores_list'] });
    const [req] = llm.requests;
    expect(req!.user).toContain('inclua também o banco de horas');
    expect(req!.user).toContain('<definition>');
    expect(req!.context).toContain('rh_colaboradores_list');
  });

  it('audits every generation without the prompt text', async () => {
    llm.answer(new UpstreamError(msg('llm.timeout')));
    expect((await generate({ prompt: PROMPT })).statusCode).toBe(502);
    const audit = (await call('GET', '/audit?action=composite.generate', undefined, admin)).json();
    const text = JSON.stringify(audit);
    expect(audit.items.length).toBeGreaterThan(5);
    expect(text).not.toContain('resumo do colaborador com escala');
    expect(text).toContain('promptSha256');
    expect(audit.items.map((i: { decision: string }) => i.decision)).toEqual(expect.arrayContaining(['valid', 'invalid', 'error']));
  });

  it('rate limits generations per tenant', async () => {
    await h.services.repos.llmSettings.upsert(seeded.tenantId, { provider: 'anthropic', model: 'claude-opus-5-5', maxGenerationsPerHour: 2 }, 'admin');
    llm.answer(answer(RESUMO));
    const r = await generate({ prompt: PROMPT }, admin);
    expect(r.statusCode).toBe(429);
    expect(llm.requests).toHaveLength(0);
  });
});

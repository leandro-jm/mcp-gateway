import { msg, translate } from '@mcp-gateway/i18n/server';
import { describe, expect, it } from 'vitest';
import { CompositeError, CompositeParseError, executeComposite, parseComposite, validateComposite, type CatalogTool, type CompositeDefinition } from '../src';

const tool = (name: string, extra: Partial<CatalogTool> = {}): CatalogTool => ({
  id: `id-${name}`,
  name,
  kind: 'openapi',
  state: 'enabled',
  inputSchema: { type: 'object', properties: { id: { type: 'string' }, colaborador: { type: 'string' }, desde: { type: 'string' } }, additionalProperties: false },
  annotations: { readOnlyHint: true },
  ...extra,
});

const catalog = new Map(
  [
    tool('rh_colaboradores_get', { inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } }),
    tool('rh_escalas_list'),
    tool('rh_marcacoes_list'),
    tool('rh_marcacao_delete', { annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }),
    tool('rh_antiga', { state: 'removed' }),
    tool('rh_composta', { kind: 'composite' }),
  ].map((t) => [t.name, t]),
);

const YAML = `
name: rh_resumo_colaborador
description: Dados do colaborador, escala atual e últimas marcações
input:
  type: object
  required: [colaborador_id]
  properties:
    colaborador_id: { type: string }
    desde: { type: string, format: date }
steps:
  - id: colab
    tool: rh_colaboradores_get
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
    "escala_atual": $steps.escalas[0],
    "ultimas_marcacoes": $steps.marcacoes[[0..9]]
  }
failure_mode: partial
timeout_ms: 8000
`;

describe('composition language (F7b.2)', () => {
  it('reads the PLAN YAML, infers the DAG and inherits annotations', () => {
    const def = parseComposite(YAML);
    const v = validateComposite(def, catalog);
    expect(v.errors).toEqual([]);
    expect(v.levels).toEqual([['colab'], ['escalas', 'marcacoes']]);
    expect(v.dependsOn.sort()).toEqual(['id-rh_colaboradores_get', 'id-rh_escalas_list', 'id-rh_marcacoes_list']);
    expect(v.annotations).toEqual({ readOnlyHint: true, idempotentHint: true });
  });

  const base = (): CompositeDefinition => parseComposite(YAML);
  const errorsOf = (def: CompositeDefinition) => validateComposite(def, catalog).errors.map((e) => translate(e.message));

  it('rejects cycles', () => {
    const def = base();
    def.steps[0]!.args = { id: '$steps.escalas[0].id' };
    expect(errorsOf(def).join()).toContain('cycle between steps');
  });

  it('rejects references to unknown steps and to itself', () => {
    const def = base();
    def.steps[1]!.args = { colaborador: '$steps.fantasma.id' };
    def.steps[2]!.when = '$exists($steps.marcacoes)';
    const errs = errorsOf(def);
    expect(errs).toContain('reference to unknown step: fantasma');
    expect(errs).toContain('step references itself');
  });

  it('rejects unknown, removed or composite tools', () => {
    const def = base();
    def.steps[0]!.tool = 'nao_existe';
    def.steps[1]!.tool = 'rh_antiga';
    def.steps[2]!.tool = 'rh_composta';
    const errs = errorsOf(def);
    expect(errs).toEqual(expect.arrayContaining(['unknown tool: nao_existe', 'removed tool: rh_antiga', 'a step cannot call another composite tool (v1)']));
  });

  it('checks args against the input schema (required, unknown, literal type)', () => {
    const def = base();
    def.steps[0]!.args = { outro: 1 };
    def.steps[1]!.args = { colaborador: 123 };
    const errs = errorsOf(def);
    expect(errs).toEqual(
      expect.arrayContaining([
        'missing required argument for rh_colaboradores_get: id',
        'argument not accepted by rh_colaboradores_get',
        'literal incompatible with type "string"',
      ]),
    );
  });

  it('rejects invalid JSONata and invalid fields in the definition', () => {
    const def = base();
    def.output = '{ "x": $steps.colab.( }';
    expect(errorsOf(def)[0]).toContain('invalid expression');
    expect(() => parseComposite('name: X\nsteps: []')).toThrow(/invalid definition/);
  });

  it('inherits destructiveHint from any step', () => {
    const def = base();
    def.steps.push({ id: 'del', tool: 'rh_marcacao_delete', args: { id: '$steps.colab.id' } } as never);
    expect(validateComposite(def, catalog).annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
  });
});

describe('executor (F7b.3)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const fake = (latency: Record<string, number>, fail: string[] = []) => {
    const calls: Array<{ tool: string; args: unknown; at: number }> = [];
    const t0 = Date.now();
    return {
      calls,
      callStep: async ({ tool, args }: { tool: string; args: Record<string, unknown> }) => {
        calls.push({ tool, args, at: Date.now() - t0 });
        await sleep(latency[tool] ?? 10);
        if (fail.includes(tool)) throw Object.assign(new Error(`${tool} failed`), { code: 'UPSTREAM_ERROR' });
        if (tool === 'rh_colaboradores_get') return { id: args.id, nome: 'Ana' };
        if (tool === 'rh_escalas_list') return [{ id: 'esc-1' }, { id: 'esc-2' }];
        return Array.from({ length: 15 }, (_, i) => ({ id: `m${i}`, colaborador: args.colaborador }));
      },
    };
  };

  it('3 steps with 2 parallel run in ~max(latencies), not the sum', async () => {
    const f = fake({ rh_colaboradores_get: 50, rh_escalas_list: 150, rh_marcacoes_list: 150 });
    const r = await executeComposite(parseComposite(YAML), { colaborador_id: 'c1', desde: '2026-09-01' }, { callStep: f.callStep });
    expect(r.durationMs).toBeLessThan(50 + 150 + 120); // the sum would be ~350
    expect(r.durationMs).toBeGreaterThanOrEqual(195);
    expect(r.output).toEqual({ nome: 'Ana', escala_atual: { id: 'esc-1' }, ultimas_marcacoes: Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, colaborador: 'c1' })) });
    expect(f.calls.find((c) => c.tool === 'rh_marcacoes_list')!.args).toEqual({ colaborador: 'c1', desde: '2026-09-01' });
  });

  it('false when skips the step (default value)', async () => {
    const f = fake({});
    const r = await executeComposite(parseComposite(YAML), { colaborador_id: 'c1' }, { callStep: f.callStep });
    expect(r.steps.marcacoes!.status).toBe('skipped');
    expect(f.calls.map((c) => c.tool)).not.toContain('rh_marcacoes_list');
    expect(r.output).toEqual({ nome: 'Ana', escala_atual: { id: 'esc-1' } });
  });

  it('partial: failed steps become null with per-step _errors; dependents are not called', async () => {
    const f = fake({}, ['rh_escalas_list']);
    const r = await executeComposite(parseComposite(YAML), { colaborador_id: 'c1', desde: '2026-09-01' }, { callStep: f.callStep });
    expect(r.output).toMatchObject({ nome: 'Ana', _errors: { escalas: { message: 'rh_escalas_list failed', code: 'UPSTREAM_ERROR' } } });
    expect(r.errors.escalas).toEqual({ message: 'rh_escalas_list failed', code: 'UPSTREAM_ERROR', msg: { key: 'common.raw', params: { text: 'rh_escalas_list failed' } } });
    expect((r.output as any).ultimas_marcacoes).toHaveLength(10);

    const def = parseComposite(YAML);
    const f2 = fake({}, ['rh_colaboradores_get']);
    const r2 = await executeComposite(def, { colaborador_id: 'c1', desde: '2026-09-01' }, { callStep: f2.callStep });
    expect(Object.keys(r2.errors).sort()).toEqual(['colab', 'escalas', 'marcacoes']);
    expect(r2.errors.escalas!.code).toBe('DEPENDENCY_FAILED');
    expect(r2.errors.escalas!.msg).toEqual(msg('composition.dependencyFailed', { step: 'colab' }));
    expect(r2.errors.escalas!.message).toBe('dependency colab failed');
    expect(f2.calls).toHaveLength(1);
  });

  it('abort: any step failure becomes an error naming the step', async () => {
    const def = { ...parseComposite(YAML), failure_mode: 'abort' as const };
    await expect(executeComposite(def, { colaborador_id: 'c1', desde: 'x' }, { callStep: fake({}, ['rh_marcacoes_list']).callStep })).rejects.toMatchObject({
      stepId: 'marcacoes',
      message: 'step marcacoes failed: rh_marcacoes_list failed',
    });
  });

  it('foreach with concurrency and max_items; total call limit', async () => {
    const def = parseComposite({
      name: 'fanout',
      description: 'x',
      steps: [
        { id: 'escalas', tool: 'rh_escalas_list', args: {} },
        { id: 'colabs', tool: 'rh_colaboradores_get', args: { id: '$item.id' }, foreach: { items: '$steps.escalas', concurrency: 2, max_items: 5 } },
      ],
      output: '$steps.colabs.id',
    });
    const f = fake({ rh_colaboradores_get: 30 });
    const r = await executeComposite(def, {}, { callStep: f.callStep });
    expect(r.output).toEqual(['esc-1', 'esc-2']);
    expect(r.calls).toBe(3);
    await expect(executeComposite(def, {}, { callStep: f.callStep, limits: { maxCalls: 2 } })).rejects.toMatchObject({ code: 'LIMIT_CALLS' });
    const tooMany = { ...def, steps: [def.steps[0]!, { ...def.steps[1]!, foreach: { ...def.steps[1]!.foreach!, max_items: 1 } }] };
    await expect(executeComposite(tooMany, {}, { callStep: f.callStep })).rejects.toMatchObject({ code: 'LIMIT_FOREACH' });
  });

  it('per-step and global timeout', async () => {
    const def = parseComposite(YAML);
    def.steps[1]!.timeout_ms = 30;
    const r = await executeComposite(def, { colaborador_id: 'c1' }, { callStep: fake({ rh_escalas_list: 200 }).callStep });
    expect(r.errors.escalas!.code).toBe('TIMEOUT');
    const slow = { ...parseComposite(YAML), timeout_ms: 60, failure_mode: 'abort' as const };
    await expect(executeComposite(slow, { colaborador_id: 'c1' }, { callStep: fake({ rh_escalas_list: 300 }).callStep })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('runaway expressions hit the JSONata guardrails instead of blocking the event loop (ADR-013)', async () => {
    const exponential = { ...parseComposite(YAML), output: '( $f := function($n){ $n>0 ? $f($n-1)+$f($n-1) : 0 }; $f(40) )' };
    const t0 = Date.now();
    await expect(executeComposite(exponential, { colaborador_id: 'c1' }, { callStep: fake({}).callStep })).rejects.toMatchObject({ code: 'LIMIT_EXPR' });
    expect(Date.now() - t0).toBeLessThan(3000);

    const deep = parseComposite(YAML);
    deep.steps[2]!.when = '( $f := function($n){ $n>0 ? 1+$f($n-1) : 0 }; $f(100000) > 0 )';
    const r = await executeComposite(deep, { colaborador_id: 'c1', desde: 'x' }, { callStep: fake({}).callStep });
    expect(r.errors.marcacoes!.code).toBe('LIMIT_EXPR');
    expect(r.errors.marcacoes!.msg!.key).toBe('composition.exprLimit');
  });

  it('per-step cache: same tool + args calls once', async () => {
    const def = parseComposite({
      name: 'dup',
      description: 'x',
      steps: [
        { id: 'a', tool: 'rh_colaboradores_get', args: { id: 'c1' } },
        { id: 'b', tool: 'rh_colaboradores_get', args: { id: 'c1' } },
      ],
    });
    const f = fake({});
    await executeComposite(def, {}, { callStep: f.callStep });
    expect(f.calls).toHaveLength(1);
  });
});

describe('localized messages (ADR-012)', () => {
  const base = (): CompositeDefinition => parseComposite(YAML);

  it('issues carry Messages rendered in the caller locale', () => {
    const def = base();
    def.steps[0]!.tool = 'nao_existe';
    const issue = validateComposite(def, catalog).errors.find((e) => e.path === 'steps[0](colab).tool')!;
    expect(issue.message).toEqual(msg('composition.unknownTool', { tool: 'nao_existe' }));
    expect(translate(issue.message, 'pt-BR')).toBe('tool inexistente: nao_existe');
    expect(translate(issue.message, 'es')).toBe('tool inexistente: nao_existe');
  });

  it('cycle error is a Message', () => {
    const def = base();
    def.steps[0]!.args = { id: '$steps.escalas[0].id' };
    const issue = validateComposite(def, catalog).errors.find((e) => e.path === 'steps')!;
    expect(issue.message.key).toBe('composition.cycle');
    expect(translate(issue.message, 'pt-BR')).toMatch(/^ciclo entre os steps: /);
  });

  it('CompositeParseError: English message, issues and a translatable msg', () => {
    let err: CompositeParseError | undefined;
    try {
      parseComposite('{ invalid json');
    } catch (e) {
      err = e as CompositeParseError;
    }
    expect(err).toBeInstanceOf(CompositeParseError);
    expect(err!.issues[0]!.path).toBe('(root)');
    expect(err!.issues[0]!.message.key).toBe('composition.invalidYaml');
    expect(err!.message).toMatch(/^invalid definition: \(root\): invalid YAML\/JSON: /);
    expect(translate(err!.msg, 'pt-BR')).toMatch(/^definição inválida: \(root\): YAML\/JSON inválido: /);
  });

  it('CompositeParseError joins several issues', () => {
    const err = new CompositeParseError([
      { path: 'a', message: msg('composition.selfReference') },
      { path: 'b', message: msg('composition.unknownStep', { step: 'x' }) },
    ]);
    expect(err.message).toBe('invalid definition: a: step references itself; b: reference to unknown step: x');
    expect(translate(err.msg, 'es')).toBe('definición inválida: a: el step se referencia a sí mismo; b: referencia a un step inexistente: x');
  });

  it('CompositeError keeps the Message of wrapped errors', () => {
    const inner = Object.assign(new Error('denied'), { msg: msg('composition.globalTimeout'), code: 'X' });
    const e = CompositeError.from(inner, 's1');
    expect(e.msg).toEqual(msg('composition.globalTimeout'));
    expect(e.code).toBe('X');
    expect(e.cause).toBe(inner);
    expect(CompositeError.from(new Error('boom')).msg).toEqual({ key: 'common.raw', params: { text: 'boom' } });
  });

  it('partial output _errors are rendered in the requested locale', async () => {
    const def = parseComposite({
      name: 'dep',
      description: 'x',
      failure_mode: 'partial',
      steps: [
        { id: 'a', tool: 'rh_colaboradores_get', args: { id: 'c1' } },
        { id: 'b', tool: 'rh_escalas_list', args: { colaborador: '$steps.a.id' } },
      ],
    });
    const callStep = async () => {
      throw new Error('upstream down');
    };
    const r = await executeComposite(def, {}, { callStep, locale: 'pt-BR' });
    expect((r.output as { _errors: unknown })._errors).toEqual({
      a: { message: 'upstream down' },
      b: { message: 'dependência a falhou', code: 'DEPENDENCY_FAILED' },
    });
  });
});

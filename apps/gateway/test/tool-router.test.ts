import { RateLimited } from '@mcp-gateway/core';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger';
import type { CallContext } from '../src/proxy/executor';
import { CircuitBreaker } from '../src/proxy/guards';
import type { RegistrySnapshot, SnapshotTool } from '../src/registry/snapshot';
import { toRoutable, ToolRouter, type DecisionCache, type ToolRouterDeps } from '../src/router';
import { chooseTool, FakeDecisions } from './fake-decisions';

const CPF = '529.982.247-25';
const mask = (s: string) => s.replaceAll(CPF, '[cpf]');

function tool(name: string, annotations: SnapshotTool['annotations'] = { readOnlyHint: true }, tags: string[] = []): SnapshotTool {
  return {
    id: `id-${name}`,
    kind: 'openapi',
    sourceId: 's1',
    compositeDefId: null,
    name,
    baseName: name,
    title: null,
    description: `Does ${name}`,
    inputSchema: { type: 'object' },
    outputSchema: null,
    annotations,
    state: 'enabled',
    operationRef: null,
    ownerTeam: null,
    version: 1,
    tags,
  };
}

function ctx(toolRouter: unknown, extra: Partial<CallContext> = {}): CallContext {
  const snapshot = {
    tenant: { id: 't1', slug: 't1', status: 'active', settings: { toolRouter } },
    builtAt: '2026-10-22T00:00:00.000Z',
    generation: 1,
    tools: [],
    sources: [],
    virtualServers: [],
    policies: [],
    piiRules: [],
    projections: [],
    composites: [],
  } as RegistrySnapshot;
  return { tenantId: 't1', principal: { sub: 'u', tenantId: 't1', roles: [], groups: [], claims: {}, locale: 'en' } as never, snapshot, ...extra };
}

class MemoryCache implements DecisionCache {
  readonly data = new Map<string, string[]>();
  async get(key: string) {
    return this.data.get(key);
  }
  async set(key: string, names: string[]) {
    this.data.set(key, names);
  }
}

function setup(opts: { configured?: boolean; budget?: () => Promise<void> } = {}) {
  const fake = new FakeDecisions();
  const cache = new MemoryCache();
  const sentArgs: unknown[] = [];
  const deps: ToolRouterDeps = {
    settingsRepo: { getDecrypted: async () => (opts.configured === false ? null : ({ provider: 'openai_decisions', model: 'gpt-6-luna', baseUrl: null, apiKey: 'k' } as never)) },
    providers: fake.factory,
    cache,
    budget: { check: opts.budget ?? (async () => undefined) },
    circuit: new CircuitBreaker(),
    pii: {
      redactText: async (_c, text) => mask(text),
      redactForLog: async (_c, _t, value) => {
        const v = JSON.parse(mask(JSON.stringify(value)));
        sentArgs.push(v);
        return v;
      },
    },
    logger: createLogger('silent'),
    allowPrivateNetworks: true,
  };
  return { router: new ToolRouter(deps), fake, cache, sentArgs };
}

const ON = { enabled: true };
const pool = ['a_list', 'b_list', 'c_list', 'd_list'].map((n) => toRoutable(tool(n)));

describe('switches (F19.4)', () => {
  it('is off by default and per point', () => {
    const { router } = setup();
    expect(router.enabledFor(ctx(undefined), 'rerank')).toBe(false);
    expect(router.enabledFor(ctx(ON), 'rerank')).toBe(true);
    expect(router.enabledFor(ctx(ON), 'shortlist')).toBe(false);
    expect(router.enabledFor(ctx({ ...ON, rerank: { enabled: false } }), 'rerank')).toBe(false);
    expect(router.enabledFor(ctx({ enabled: false, gate: { enabled: true } }), 'gate')).toBe(false);
  });

  it('gate scope follows the tool annotations', () => {
    const { router } = setup();
    const c = (scope: string) => ctx({ ...ON, gate: { enabled: true, scope } });
    const read = tool('r', { readOnlyHint: true });
    const write = tool('w', { readOnlyHint: false });
    const del = tool('d', { readOnlyHint: false, destructiveHint: true });
    expect([read, write, del].map((t) => router.gateApplies(c('non-readonly'), t))).toEqual([false, true, true]);
    expect([read, write, del].map((t) => router.gateApplies(c('destructive'), t))).toEqual([false, false, true]);
    expect([read, write, del].map((t) => router.gateApplies(c('all'), t))).toEqual([true, true, true]);
  });
});

describe('rerank (F19.4)', () => {
  it('moves the chosen candidate to the top, keeps the rest in search order and caches', async () => {
    const { router, fake } = setup();
    fake.answer({ tool: chooseTool('c_list') });
    const r = await router.rerank(ctx(ON), `férias do CPF ${CPF}`, pool, 3);
    expect(r.names).toEqual(['c_list', 'a_list', 'b_list']);
    expect(r.decision).toMatchObject({ plugin: 'decision-model', point: 'rerank', decision: 'applied', reason: 'ok', provider: 'openai_decisions', candidates: 4 });
    expect(fake.requests[0]!.input).toContain('férias do CPF [cpf]');
    expect(fake.requests[0]!.input).not.toContain(CPF);

    const again = await router.rerank(ctx(ON), `férias do CPF ${CPF}`, pool, 3);
    expect(again.names).toEqual(['c_list', 'a_list', 'b_list']);
    expect(again.decision).toMatchObject({ cached: true, decision: 'applied' });
    expect(fake.requests).toHaveLength(1);
  });

  it('keeps the search order on none, errors, timeouts and missing provider', async () => {
    const original = ['a_list', 'b_list', 'c_list'];
    const none = setup();
    none.fake.answer({ tool: { type: 'choice', choice: 'none', probabilities: { none: 1 } } });
    expect(await none.router.rerank(ctx(ON), 'q', pool, 3)).toMatchObject({ names: original, applied: false, decision: { reason: 'none_option' } });

    const error = setup();
    error.fake.answer(new Error('boom'));
    expect(await error.router.rerank(ctx(ON), 'q', pool, 3)).toMatchObject({ names: original, decision: { reason: 'error', decision: 'skipped' } });

    const slow = setup();
    slow.fake.answer((_req, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason))));
    const timed = await slow.router.rerank(ctx({ ...ON, rerank: { timeoutMs: 100 } }), 'q', pool, 3);
    expect(timed).toMatchObject({ names: original, decision: { reason: 'timeout' } });

    const missing = setup({ configured: false });
    expect(await missing.router.rerank(ctx(ON), 'q', pool, 3)).toMatchObject({ names: original, decision: { reason: 'disabled' } });
  });

  it('falls back on budget and opens the circuit after repeated failures', async () => {
    const budget = setup({ budget: async () => Promise.reject(new RateLimited('router', 1000)) });
    expect((await budget.router.rerank(ctx(ON), 'q', pool, 3)).decision.reason).toBe('budget');
    expect(budget.fake.requests).toHaveLength(0);

    const flaky = setup();
    flaky.fake.answer(new Error('down'));
    for (let i = 0; i < 5; i++) await flaky.router.rerank(ctx({ ...ON, cacheTtlSeconds: 0 }), `q${i}`, pool, 3);
    const r = await flaky.router.rerank(ctx(ON), 'q', pool, 3);
    expect(r.decision.reason).toBe('circuit_open');
    expect(flaky.fake.requests).toHaveLength(5);
  });

  it('never returns a name the input did not have', async () => {
    const { router, fake } = setup();
    fake.answer(async () => ({ answers: { tool: { type: 'choice', choice: 't9', probabilities: { t9: 1 } } } }));
    const r = await router.rerank(ctx(ON), 'q', pool, 4);
    expect(r.names).toEqual(['a_list', 'b_list', 'c_list', 'd_list']);
    expect(r.applied).toBe(false);
  });
});

describe('shortlist (F19.4)', () => {
  const visible = [tool('rh_ferias_list'), tool('rh_ferias_get'), tool('rh_ponto_list'), tool('fin_pag_list'), tool('fin_pag_get'), tool('ops_ronda_list')];
  const settings = { ...ON, shortlist: { enabled: true, minTools: 2 } };

  it('skips without an intent and keeps the full list', async () => {
    const { router, fake } = setup();
    const r = await router.shortlist(ctx(settings), '  ', visible);
    expect(r).toMatchObject({ applied: false, decision: { reason: 'no_intent' } });
    expect(r.names).toHaveLength(6);
    expect(fake.requests).toHaveLength(0);
  });

  it('keeps the chosen namespaces', async () => {
    const { router, fake } = setup();
    fake.answer({
      namespace: (req) => {
        const q = req.questions[0]!;
        const opt = q.type === 'choice' ? q.choices.find((c) => c.description.startsWith('rh_ferias:'))! : undefined;
        return { type: 'choice', choice: opt!.value, probabilities: { [opt!.value]: 0.95 }, confidence: 0.95 };
      },
    });
    const r = await router.shortlist(ctx(settings), 'férias', visible);
    expect(r.names).toEqual(['rh_ferias_list', 'rh_ferias_get']);
    expect(r.decision).toMatchObject({ point: 'shortlist', decision: 'applied', kept: 2 });
  });

  it('falls back to the full list on provider errors', async () => {
    const { router, fake } = setup();
    fake.answer(new Error('down'));
    const r = await router.shortlist(ctx(settings), 'férias', visible);
    expect(r.names).toEqual(visible.map((t) => t.name));
    expect(r.decision.reason).toBe('error');
  });
});

describe('gate (F19.4)', () => {
  const del = tool('rh_ferias_delete', { readOnlyHint: false, destructiveHint: true });
  const g = (gate: Record<string, unknown> = {}) => ({ ...ON, gate: { enabled: true, ...gate } });

  it('denies, asks for confirmation or allows by the risk probability', async () => {
    const { router, fake } = setup();
    fake.answer({ risky: { type: 'predicate', probability: 0.95 } }, { risky: { type: 'predicate', probability: 0.6 } }, { risky: { type: 'predicate', probability: 0.1 } });
    expect(await router.gate(ctx(g()), del, { id: '1' })).toMatchObject({ outcome: 'deny', effective: 'deny', message: 'router.gateDenied' });
    expect(await router.gate(ctx(g()), del, { id: '1' })).toMatchObject({ outcome: 'confirm', effective: 'deny', message: 'router.confirmationRequired' });
    expect(await router.gate(ctx(g()), del, { id: '1' })).toMatchObject({ outcome: 'allow', effective: 'allow' });
  });

  it('lets a confirm through when the tenant allows it', async () => {
    const { router, fake } = setup();
    fake.answer({ risky: { type: 'predicate', probability: 0.6 } });
    expect(await router.gate(ctx(g({ onConfirmWithoutUi: 'allow' })), del, {})).toMatchObject({ outcome: 'confirm', effective: 'allow' });
  });

  it('skips the provider after a human confirmation', async () => {
    const { router, fake } = setup();
    fake.forbid();
    const r = await router.gate(ctx(g(), { ui: { confirmed: true } }), del, {});
    expect(r).toMatchObject({ effective: 'allow', decision: { reason: 'human_confirmed' } });
    expect(fake.requests).toHaveLength(0);
  });

  it('applies onError on failures and unusable answers', async () => {
    const allow = setup();
    allow.fake.answer(new Error('down'));
    expect(await allow.router.gate(ctx(g()), del, {})).toMatchObject({ outcome: 'allow', effective: 'allow', decision: { reason: 'error' } });
    const deny = setup();
    deny.fake.answer({});
    expect(await deny.router.gate(ctx(g({ onError: 'deny' })), del, {})).toMatchObject({ outcome: 'deny', effective: 'deny', decision: { reason: 'invalid' } });
  });

  it('sends redacted arguments, or only their names', async () => {
    const redacted = setup();
    redacted.fake.answer({ risky: { type: 'predicate', probability: 0.1 } });
    await redacted.router.gate(ctx(g()), del, { cpf: CPF, motivo: 'erro' });
    expect(redacted.fake.requests[0]!.input).toContain('[cpf]');
    expect(redacted.fake.requests[0]!.input).not.toContain(CPF);

    const names = setup();
    names.fake.answer({ risky: { type: 'predicate', probability: 0.1 } });
    await names.router.gate(ctx(g({ argsMode: 'none' })), del, { cpf: CPF, motivo: 'erro' });
    expect(names.fake.requests[0]!.input).toContain('["cpf","motivo"]');
    expect(names.fake.requests[0]!.input).not.toContain('erro');
    expect(names.sentArgs).toHaveLength(0);
  });

  it('asks off_intent only when the agent declared an intent', async () => {
    const { router, fake } = setup();
    fake.answer({ risky: { type: 'predicate', probability: 0.1 }, off_intent: { type: 'predicate', probability: 0.92 } });
    const r = await router.gate(ctx(g(), { intent: `consultar férias ${CPF}` }), del, {});
    expect(r.outcome).toBe('deny');
    expect(fake.requests[0]!.questions.map((q) => q.name)).toEqual(['risky', 'off_intent']);
    expect(fake.requests[0]!.input).not.toContain(CPF);
  });
});

import { describe, expect, it } from 'vitest';
import type { RoutableTool } from './builders';
import { decisionCacheKey } from './cache-key';
import { createDecisionModelPlugin, type DecisionModelOptions } from './decision-model-plugin';
import type { DecisionAnswer, DecisionProvider, DecisionRequest } from './model';
import { mostRestrictive, subsetOf } from './plugin';

/** Answers every question with the scripted answer for its name. */
function stub(answers: Record<string, DecisionAnswer>, id: DecisionProvider['id'] = 'openai-decisions') {
  const seen: DecisionRequest[] = [];
  const provider: DecisionProvider = {
    id,
    model: 'm',
    async decide(req) {
      seen.push(req);
      return { answers };
    },
    async ping() {},
  };
  return { provider, seen };
}

const options: DecisionModelOptions = {
  rerank: { minConfidence: 0.35 },
  shortlist: { granularity: 'namespace', minConfidence: 0.35, mass: 0.9, maxNamespaces: 3, minTools: 2, maxTools: 30 },
  gate: { confirmAt: 0.5, denyAt: 0.9 },
};
const tool = (name: string): RoutableTool => ({ name, description: name });
const ctx = { tenantId: 't' };

describe('invariants (F19.2)', () => {
  it('subsetOf drops names the input did not have and duplicates', () => {
    expect(subsetOf(['a', 'b'], ['b', 'z', 'b', 'a'])).toEqual(['b', 'a']);
  });

  it('mostRestrictive orders deny > confirm > allow', () => {
    expect(mostRestrictive('allow', 'confirm')).toBe('confirm');
    expect(mostRestrictive('deny', 'confirm')).toBe('deny');
    expect(mostRestrictive('allow', 'allow')).toBe('allow');
  });

  it('cache keys ignore candidate order and separate tenants', () => {
    const k = (tenantId: string, candidates: string[]) => decisionCacheKey({ tenantId, point: 'rerank', provider: 'jev', model: 'm', catalog: 'c', text: 'Q', candidates });
    expect(k('t1', ['a', 'b'])).toBe(k('t1', ['b', 'a']));
    expect(k('t1', ['a'])).not.toBe(k('t2', ['a']));
    expect(k('t1', ['a'])).toMatch(/^tr:t1:[0-9a-f]{40}$/);
  });
});

describe('decision-model plugin (F19.2)', () => {
  it('rerank returns the chosen tools in probability order', async () => {
    const { provider } = stub({ tool: { type: 'choice', choice: 't3', probabilities: { t3: 0.7, t1: 0.2, t2: 0.01 }, confidence: 0.7 } });
    const r = await createDecisionModelPlugin(provider, options).rerank!(ctx, { query: 'q', candidates: [tool('a'), tool('b'), tool('c')] });
    expect(r.value).toEqual(['c', 'a']);
    expect(r.decision).toMatchObject({ plugin: 'decision-model', point: 'rerank', decision: 'applied', reason: 'ok', provider: 'openai-decisions', candidates: 3, kept: 2, confidence: 'medium' });
  });

  it('rerank abstains on none', async () => {
    const { provider } = stub({ tool: { type: 'choice', choice: 'none', probabilities: { none: 1 } } });
    const r = await createDecisionModelPlugin(provider, options).rerank!(ctx, { query: 'q', candidates: [tool('a')] });
    expect(r.value).toBeUndefined();
    expect(r.decision).toMatchObject({ decision: 'skipped', reason: 'none_option' });
  });

  it('shortlist keeps whole namespaces by mass, in probability order', async () => {
    // Namespaces are offered sorted: n1 = fin_pagamentos, n2 = rh_ferias, n3 = rh_marcacoes.
    const { provider } = stub({ namespace: { type: 'choice', choice: 'n2', probabilities: { n2: 0.6, n3: 0.35, n1: 0.05 }, confidence: 0.6 } });
    const tools = ['fin_pagamentos_list', 'rh_marcacoes_list', 'rh_ferias_list', 'rh_ferias_create'].map(tool);
    const r = await createDecisionModelPlugin(provider, options).shortlist!(ctx, { intent: 'férias e ponto', tools });
    expect(r.value).toEqual(['rh_ferias_list', 'rh_ferias_create', 'rh_marcacoes_list']);
    expect(r.decision).toMatchObject({ point: 'shortlist', decision: 'applied', kept: 3, candidates: 3 });
  });

  it('shortlist adds namespaces until minTools', async () => {
    const { provider } = stub({ namespace: { type: 'choice', choice: 'n2', probabilities: { n2: 0.95 }, confidence: 0.95 } });
    const tools = ['a_x_list', 'b_y_list'].map(tool);
    const r = await createDecisionModelPlugin(provider, options).shortlist!(ctx, { intent: 'y', tools });
    expect(r.value).toEqual(['b_y_list', 'a_x_list']);
  });

  it('shortlist by tool keeps the head by mass and fills to minTools', async () => {
    const { provider } = stub({ tool: { type: 'choice', choice: 't2', probabilities: { t2: 0.95 }, confidence: 0.95 } });
    const plugin = createDecisionModelPlugin(provider, { ...options, shortlist: { ...options.shortlist, granularity: 'tool', minTools: 2 } });
    const r = await plugin.shortlist!(ctx, { intent: 'i', tools: ['a', 'b', 'c'].map(tool) });
    expect(r.value).toEqual(['b', 'a']);
  });

  it('shortlist abstains with too_many when namespaces exceed the provider limit', async () => {
    const { provider, seen } = stub({});
    const plugin = createDecisionModelPlugin(provider, { ...options, maxChoices: 2 });
    const r = await plugin.shortlist!(ctx, { intent: 'i', tools: ['a_x_l', 'b_y_l'].map(tool) });
    expect(r.decision).toMatchObject({ decision: 'skipped', reason: 'too_many' });
    expect(seen).toHaveLength(0);
  });

  it('gate maps probabilities to outcomes and abstains on unusable answers', async () => {
    const deny = await createDecisionModelPlugin(stub({ risky: { type: 'predicate', probability: 0.95 } }).provider, options).gate!(ctx, { tool: tool('x'), args: {} });
    expect(deny).toMatchObject({ value: 'deny', decision: { point: 'gate', decision: 'deny', reason: 'ok' } });
    const none = await createDecisionModelPlugin(stub({}).provider, options).gate!(ctx, { tool: tool('x'), args: {} });
    expect(none.value).toBeUndefined();
    expect(none.decision.reason).toBe('invalid');
  });

  it('uses the Jev choice limit when the provider is Jev', async () => {
    const { provider, seen } = stub({ tool: { type: 'choice', choice: 'none', probabilities: {} } }, 'jev');
    const candidates = Array.from({ length: 300 }, (_, i) => tool(`t${i}`));
    await createDecisionModelPlugin(provider, options).rerank!(ctx, { query: 'q', candidates });
    const q = seen[0]!.questions[0]!;
    expect(q.type === 'choice' && q.choices.length).toBe(255);
  });
});

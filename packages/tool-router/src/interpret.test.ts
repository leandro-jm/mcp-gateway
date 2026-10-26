import { describe, expect, it } from 'vitest';
import { confidenceBucket, interpretChoice, interpretGate, mergeRanking, takeByMass } from './interpret';

const map = new Map([
  ['t1', 'a'],
  ['t2', 'b'],
  ['t3', 'c'],
]);

describe('interpretChoice (F19.2)', () => {
  it('ranks offered options by probability and drops noise below the floor', () => {
    const out = interpretChoice({ type: 'choice', choice: 't2', probabilities: { t1: 0.3, t2: 0.6, t3: 0.01, none: 0.09 }, confidence: 0.6 }, map, { minConfidence: 0.35 });
    expect(out).toEqual({ status: 'ok', ranked: ['b', 'a'], weights: [0.6, 0.3], confidence: 'medium' });
  });

  it('ignores options that were never offered', () => {
    const out = interpretChoice({ type: 'choice', choice: 't1', probabilities: { t1: 0.5, injected: 0.5 } }, map, { minConfidence: 0 });
    expect(out.ranked).toEqual(['a']);
    expect(interpretChoice({ type: 'choice', choice: 'injected', probabilities: {} }, map, { minConfidence: 0 }).status).toBe('invalid');
  });

  it('reports none, low confidence, refusal and missing answers', () => {
    expect(interpretChoice({ type: 'choice', choice: 'none', probabilities: { none: 0.9 } }, map, { minConfidence: 0 }).status).toBe('none_option');
    expect(interpretChoice({ type: 'choice', choice: 't1', probabilities: { t1: 0.2 } }, map, { minConfidence: 0.35 }).status).toBe('low_confidence');
    expect(interpretChoice({ type: 'refusal' }, map, { minConfidence: 0 }).status).toBe('refusal');
    expect(interpretChoice(undefined, map, { minConfidence: 0 }).status).toBe('invalid');
    expect(interpretChoice({ type: 'predicate', probability: 1 }, map, { minConfidence: 0 }).status).toBe('invalid');
  });

  it('uses the chosen option when probabilities are absent', () => {
    expect(interpretChoice({ type: 'choice', choice: 't3', probabilities: {} }, map, { minConfidence: 0.5 })).toMatchObject({ status: 'ok', ranked: ['c'] });
  });
});

describe('selection helpers (F19.2)', () => {
  it('takeByMass stops at the mass or the cap', () => {
    expect(takeByMass(['a', 'b', 'c'], [0.6, 0.35, 0.05], 0.9, 3)).toEqual(['a', 'b']);
    expect(takeByMass(['a', 'b', 'c'], [0.3, 0.3, 0.3], 0.9, 2)).toEqual(['a', 'b']);
  });

  it('mergeRanking puts decided names first and never adds unknown names', () => {
    expect(mergeRanking(['a', 'b', 'c', 'd'], ['c', 'x', 'a'], 3)).toEqual(['c', 'a', 'b']);
  });

  it('confidence buckets', () => {
    expect([confidenceBucket(0.2), confidenceBucket(0.5), confidenceBucket(0.8)]).toEqual(['low', 'medium', 'high']);
  });
});

describe('interpretGate (F19.2)', () => {
  const t = { confirmAt: 0.5, denyAt: 0.9 };
  const p = (risky: number, off?: number) => ({
    answers: { risky: { type: 'predicate' as const, probability: risky }, ...(off !== undefined ? { off_intent: { type: 'predicate' as const, probability: off } } : {}) },
  });

  it('maps the larger risk to allow, confirm or deny', () => {
    expect(interpretGate(p(0.1), t).outcome).toBe('allow');
    expect(interpretGate(p(0.6), t).outcome).toBe('confirm');
    expect(interpretGate(p(0.95), t).outcome).toBe('deny');
    expect(interpretGate(p(0.1, 0.92), t).outcome).toBe('deny');
  });

  it('a refusal asks for confirmation; a missing answer is unusable', () => {
    expect(interpretGate({ answers: { risky: { type: 'refusal' } } }, t)).toEqual({ outcome: 'confirm', reason: 'refusal' });
    expect(interpretGate({ answers: {} }, t)).toEqual({ reason: 'invalid' });
  });
});

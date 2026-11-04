import { describe, expect, it } from 'vitest';
import { argsMatch, scoreRun } from './score';
import { wilson } from './stats';
import type { CallRecord, Task } from './types';

const call = (tool: string, args: Record<string, unknown> = {}, extra: Partial<CallRecord> = {}): CallRecord => ({
  tool,
  args,
  meta: false,
  isError: false,
  errorCode: null,
  callId: null,
  latencyMs: 1,
  ...extra,
});
const catalog = new Set(['hr_employees_list', 'hr_employees_get', 'hr_employees_update']);
const multi: Task = {
  id: 't1',
  group: 'multi',
  prompt: '...',
  expected: [{ tool: 'hr_employees_list', args: { unit: 3 } }, { tool: 'hr_employees_update', args: { id: 'e1' } }],
};

describe('argsMatch', () => {
  it('matches a subset, loosely for primitives', () => {
    expect(argsMatch({ unit: 3 }, { unit: '3', status: 'active' })).toBe(true);
    expect(argsMatch({ name: 'Ana ' }, { name: 'ana' })).toBe(true);
    expect(argsMatch({ unit: 3 }, { unit: 4 })).toBe(false);
    expect(argsMatch({ filter: { unit: 3 } }, { filter: { unit: 3, x: 1 } })).toBe(true);
    expect(argsMatch({ ids: ['a'] }, { ids: ['a', 'b'] })).toBe(true);
    expect(argsMatch({ ids: ['a'] }, { ids: 'a' })).toBe(false);
    expect(argsMatch({ unit: 3 }, {})).toBe(false);
  });
});

describe('scoreRun', () => {
  it('succeeds when the expected calls happen in order, with retries allowed', () => {
    const calls = [
      call('search_tools', { query: 'x' }, { meta: true }),
      call('hr_employees_list', { unit: 'x' }, { isError: true, errorCode: 'VALIDATION_ERROR' }),
      call('hr_employees_list', { unit: 3 }),
      call('hr_employees_update', { id: 'e1', name: 'Bia' }),
    ];
    const s = scoreRun(multi, calls, catalog, 'end_turn');
    expect(s).toMatchObject({ firstCallCorrect: true, toolSequenceCorrect: true, success: true, domainCalls: 3, metaCalls: 1, validationErrors: 1, extraCalls: 1 });
  });

  it('fails on wrong order, wrong arguments or an unfinished run', () => {
    expect(scoreRun(multi, [call('hr_employees_update', { id: 'e1' }), call('hr_employees_list', { unit: 3 })], catalog, 'end_turn').success).toBe(false);
    const wrongArgs = scoreRun(multi, [call('hr_employees_list', { unit: 4 }), call('hr_employees_update', { id: 'e1' })], catalog, 'end_turn');
    expect(wrongArgs).toMatchObject({ success: false, toolSequenceCorrect: true, firstCallCorrect: true });
    expect(scoreRun(multi, [call('hr_employees_list', { unit: 3 }), call('hr_employees_update', { id: 'e1' })], catalog, 'max_turns').success).toBe(false);
  });

  it('accepts the alternative tools of an expected call', () => {
    const alt: Task = { id: 't3', group: 'ambiguous', prompt: '...', expected: [{ tool: 'hr_employees_list', args: { unit: 3 }, alt: [{ tool: 'hr_employees_get', args: { id: 'e1' } }] }] };
    expect(scoreRun(alt, [call('hr_employees_get', { id: 'e1' })], catalog, 'end_turn')).toMatchObject({ firstCallCorrect: true, success: true });
    expect(scoreRun(alt, [call('hr_employees_get', { unit: 3 })], catalog, 'end_turn')).toMatchObject({ firstCallCorrect: true, success: false });
    expect(scoreRun(alt, [call('hr_employees_update', { unit: 3 })], catalog, 'end_turn')).toMatchObject({ firstCallCorrect: false, success: false });
  });

  it('counts tools outside the catalog as hallucinated', () => {
    const s = scoreRun(multi, [call('hr_staff_list')], catalog, 'end_turn');
    expect(s).toMatchObject({ hallucinated: 1, firstCallCorrect: false, success: false });
  });

  it('scores `none` tasks by the absence of domain calls', () => {
    const none: Task = { id: 't2', group: 'none', prompt: '...', expected: [] };
    expect(scoreRun(none, [call('search_tools', {}, { meta: true })], catalog, 'end_turn')).toMatchObject({ success: true, firstCallCorrect: null });
    expect(scoreRun(none, [call('hr_employees_list')], catalog, 'end_turn').success).toBe(false);
  });
});

describe('wilson', () => {
  it('brackets the observed rate', () => {
    const w = wilson(21, 30);
    expect(w.p).toBeCloseTo(0.7, 10);
    expect(w.low).toBeCloseTo(0.521, 2);
    expect(w.high).toBeCloseTo(0.833, 2);
    expect(wilson(0, 0)).toEqual({ p: 0, low: 0, high: 0 });
  });
});

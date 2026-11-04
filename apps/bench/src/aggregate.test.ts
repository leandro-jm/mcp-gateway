import { describe, expect, it } from 'vitest';
import { summarize } from './aggregate';
import type { RunRecord } from './types';

const run = (over: Partial<RunRecord> & Pick<RunRecord, 'model' | 'scenario' | 'taskId'>, success: boolean): RunRecord => ({
  key: `${over.model}|${over.scenario}|${over.taskId}|1`,
  runId: 'r',
  phase: 1,
  group: 'single',
  rep: 1,
  pilot: false,
  startedAt: '2026-11-03T00:00:00.000Z',
  durationMs: 2000,
  toolCount: 160,
  definitionTokens: 40_000,
  turns: [
    { usage: { input: 1000, output: 200, cacheRead: 40_000, cacheWrite: 0 }, latencyMs: 1500, stopReason: 'tool_use', calls: [{ tool: 'x', args: {}, meta: false, isError: false, errorCode: null, callId: null, latencyMs: 100 }] },
    { usage: { input: 1500, output: 100, cacheRead: 40_000, cacheWrite: 0 }, latencyMs: 300, stopReason: 'end_turn', calls: [] },
  ],
  outcome: 'end_turn',
  costUsd: 0.01,
  costUncachedUsd: 0.1,
  score: { firstCallCorrect: success, toolSequenceCorrect: success, success, domainCalls: 1, metaCalls: 0, extraCalls: 0, hallucinated: 0, validationErrors: 0, otherErrors: 0 },
  ...over,
});

describe('summarize', () => {
  const records = [
    run({ model: 'm', scenario: 'A', taskId: 't1' }, true),
    run({ model: 'm', scenario: 'A', taskId: 't2', group: 'none' }, false),
    run({ model: 'm', scenario: 'B', taskId: 't1' }, true),
  ];

  it('builds one cell per model × scenario with rates, tokens, time and cost', () => {
    const [a, b] = summarize(records);
    expect(a).toMatchObject({ model: 'm', scenario: 'A', runs: 2, tasks: 2, promptTokensPerRun: 82_500, outputTokensPerRun: 300, turnsPerRun: 2, modelMsPerRun: 1800, toolMsPerRun: 100 });
    expect(a!.success).toMatchObject({ k: 1, n: 2 });
    expect(a!.byGroup.none).toMatchObject({ k: 0, n: 1 });
    expect(b!.scenario).toBe('B');
  });

  it('restricts to a set of tasks', () => {
    expect(summarize(records, new Set(['t1'])).map((c) => c.runs)).toEqual([1, 1]);
  });
});

import type { CallRecord, ExpectedCall, Outcome, Score, Task } from './types';

const norm = (v: unknown) => String(v).trim().toLowerCase();

/** `actual` contains `expected`: objects by key, arrays by position, primitives loosely ("3" = 3). */
export function argsMatch(expected: unknown, actual: unknown): boolean {
  if (expected === null || expected === undefined) return actual === expected;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length <= actual.length && expected.every((e, i) => argsMatch(e, actual.at(i)));
  }
  if (typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    const a = actual as Record<string, unknown>;
    return Object.entries(expected as Record<string, unknown>).every(([k, v]) => argsMatch(v, a[k]));
  }
  if (actual === null || actual === undefined || typeof actual === 'object') return false;
  return norm(expected) === norm(actual);
}

const options = (e: ExpectedCall) => [{ tool: e.tool, args: e.args }, ...(e.alt ?? [])];
const toolMatches = (e: ExpectedCall, tool: string) => options(e).some((o) => o.tool === tool);

const callMatches = (e: ExpectedCall, c: CallRecord, withArgs: boolean) =>
  !c.isError && options(e).some((o) => o.tool === c.tool && (!withArgs || argsMatch(o.args ?? {}, c.args)));

/** Index of each expected call matched in order (greedy subsequence), or -1. */
function matchSequence(expected: ExpectedCall[], calls: CallRecord[], withArgs: boolean): number[] {
  const at: number[] = [];
  let from = 0;
  for (const e of expected) {
    const i = calls.findIndex((c, idx) => idx >= from && callMatches(e, c, withArgs));
    at.push(i);
    if (i < 0) break;
    from = i + 1;
  }
  return at;
}

/**
 * Scores one run against its task. Success = every expected call happened, in order, with matching
 * arguments and without error, and the agent finished on its own; for `none`, no domain call at all.
 * Retries are allowed: a failed call followed by a correct one still succeeds.
 */
export function scoreRun(task: Task, calls: CallRecord[], catalog: ReadonlySet<string>, outcome: Outcome): Score {
  const domain = calls.filter((c) => !c.meta);
  const finished = outcome === 'end_turn';
  const validationErrors = domain.filter((c) => c.errorCode === 'VALIDATION_ERROR').length;
  const hallucinated = domain.filter((c) => !catalog.has(c.tool)).length;
  const base = {
    domainCalls: domain.length,
    metaCalls: calls.length - domain.length,
    hallucinated,
    validationErrors,
    otherErrors: domain.filter((c) => c.isError).length - validationErrors,
  };
  if (task.expected.length === 0) {
    const ok = finished && domain.length === 0;
    return { ...base, firstCallCorrect: null, toolSequenceCorrect: domain.length === 0, success: ok, extraCalls: domain.length };
  }
  const full = matchSequence(task.expected, domain, true);
  const toolsOnly = matchSequence(task.expected, domain, false);
  const matched = full.filter((i) => i >= 0).length;
  return {
    ...base,
    firstCallCorrect: domain.length > 0 && toolMatches(task.expected[0]!, domain[0]!.tool),
    toolSequenceCorrect: toolsOnly.length === task.expected.length && toolsOnly.every((i) => i >= 0),
    success: finished && full.length === task.expected.length && full.every((i) => i >= 0),
    extraCalls: domain.length - matched,
  };
}

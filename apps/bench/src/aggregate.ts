import { promptTokens } from './cost';
import { mean, quantile, wilson } from './stats';
import type { RunRecord, ScenarioId, TaskGroup } from './types';

export interface Rate {
  k: number;
  n: number;
  p: number;
  low: number;
  high: number;
}

export interface CellSummary {
  model: string;
  scenario: ScenarioId;
  runs: number;
  tasks: number;
  success: Rate;
  firstCallCorrect: Rate;
  toolSequenceCorrect: Rate;
  byGroup: Partial<Record<TaskGroup, Rate>>;
  definitionTokens: number | null;
  toolCount: number;
  promptTokensPerRun: number;
  outputTokensPerRun: number;
  turnsPerRun: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  modelMsPerRun: number;
  toolMsPerRun: number;
  costPerRun: number;
  costUncachedPerRun: number;
  errors: { hallucinated: number; validation: number; otherTool: number; maxTurns: number; refusal: number; error: number; extraCallsPerRun: number };
}

const rate = (k: number, n: number): Rate => ({ k, n, ...wilson(k, n) });

export function summarizeCell(rs: RunRecord[]): CellSummary {
  const first = rs[0]!;
  const withTools = rs.filter((r) => r.score.firstCallCorrect !== null);
  const byGroup: CellSummary['byGroup'] = {};
  for (const g of ['single', 'multi', 'ambiguous', 'none'] as const) {
    const gr = rs.filter((r) => r.group === g);
    if (gr.length) byGroup[g] = rate(gr.filter((r) => r.score.success).length, gr.length);
  }
  const defs = rs.map((r) => r.definitionTokens).filter((d): d is number => d !== null);
  const durations = rs.map((r) => r.durationMs);
  return {
    model: first.model,
    scenario: first.scenario,
    runs: rs.length,
    tasks: new Set(rs.map((r) => r.taskId)).size,
    success: rate(rs.filter((r) => r.score.success).length, rs.length),
    firstCallCorrect: rate(withTools.filter((r) => r.score.firstCallCorrect).length, withTools.length),
    toolSequenceCorrect: rate(withTools.filter((r) => r.score.toolSequenceCorrect).length, withTools.length),
    byGroup,
    // shortlist (D) varies per intent: the median is the representative list
    definitionTokens: defs.length ? quantile(defs, 0.5) : null,
    toolCount: quantile(rs.map((r) => r.toolCount), 0.5),
    promptTokensPerRun: mean(rs.map((r) => r.turns.reduce((s, t) => s + promptTokens(t.usage), 0))),
    outputTokensPerRun: mean(rs.map((r) => r.turns.reduce((s, t) => s + t.usage.output, 0))),
    turnsPerRun: mean(rs.map((r) => r.turns.length)),
    latencyP50Ms: quantile(durations, 0.5),
    latencyP95Ms: quantile(durations, 0.95),
    modelMsPerRun: mean(rs.map((r) => r.turns.reduce((s, t) => s + t.latencyMs, 0))),
    toolMsPerRun: mean(rs.map((r) => r.turns.reduce((s, t) => s + t.calls.reduce((c, x) => c + x.latencyMs, 0), 0))),
    costPerRun: mean(rs.map((r) => r.costUsd)),
    costUncachedPerRun: mean(rs.map((r) => r.costUncachedUsd)),
    errors: {
      hallucinated: rs.reduce((s, r) => s + r.score.hallucinated, 0),
      validation: rs.reduce((s, r) => s + r.score.validationErrors, 0),
      otherTool: rs.reduce((s, r) => s + r.score.otherErrors, 0),
      maxTurns: rs.filter((r) => r.outcome === 'max_turns').length,
      refusal: rs.filter((r) => r.outcome === 'refusal').length,
      error: rs.filter((r) => r.outcome === 'error').length,
      extraCallsPerRun: mean(rs.map((r) => r.score.extraCalls)),
    },
  };
}

/** One cell per model × scenario, optionally restricted to a set of task ids. */
export function summarize(records: RunRecord[], taskIds?: ReadonlySet<string>): CellSummary[] {
  const cells = new Map<string, RunRecord[]>();
  for (const r of records) {
    if (taskIds && !taskIds.has(r.taskId)) continue;
    const key = `${r.model}|${r.scenario}`;
    cells.set(key, [...(cells.get(key) ?? []), r]);
  }
  return [...cells.values()].map(summarizeCell).sort((a, b) => a.model.localeCompare(b.model) || a.scenario.localeCompare(b.scenario));
}

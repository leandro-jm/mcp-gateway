import { NONE_OPTION } from './builders';
import type { DecisionAnswer, DecisionResponse } from './model';

export type Confidence = 'low' | 'medium' | 'high';

/** Coarse bucket: events and metrics never carry raw probabilities. */
export function confidenceBucket(p: number): Confidence {
  return p >= 0.8 ? 'high' : p >= 0.5 ? 'medium' : 'low';
}

export type ChoiceStatus = 'ok' | 'low_confidence' | 'none_option' | 'refusal' | 'invalid';

export interface ChoiceOutcome {
  status: ChoiceStatus;
  /** Mapped names (tools or namespaces) above the noise floor, most probable first; empty unless `ok`. */
  ranked: string[];
  /** Probability of each `ranked` entry. */
  weights: number[];
  confidence?: Confidence;
}

/** Below this probability an option is noise and keeps its original position. */
export const PROBABILITY_FLOOR = 0.05;

/** Reads a choice answer; only options that were offered can come back. */
export function interpretChoice(answer: DecisionAnswer | undefined, optionToName: Map<string, string>, o: { minConfidence: number }): ChoiceOutcome {
  const empty = (status: ChoiceStatus, confidence?: Confidence): ChoiceOutcome => ({ status, ranked: [], weights: [], ...(confidence ? { confidence } : {}) });
  if (!answer) return empty('invalid');
  if (answer.type === 'refusal') return empty('refusal');
  if (answer.type !== 'choice') return empty('invalid');
  if (answer.choice !== NONE_OPTION && !optionToName.has(answer.choice)) return empty('invalid');

  const probs = new Map<string, number>();
  for (const [option, p] of Object.entries(answer.probabilities)) {
    if ((optionToName.has(option) || option === NONE_OPTION) && Number.isFinite(p)) probs.set(option, p);
  }
  if (!probs.has(answer.choice)) probs.set(answer.choice, answer.confidence ?? 1);
  const top = answer.confidence ?? probs.get(answer.choice) ?? 0;
  const confidence = confidenceBucket(top);
  if (answer.choice === NONE_OPTION) return empty('none_option', confidence);
  if (top < o.minConfidence) return empty('low_confidence', confidence);

  const ordered = [...probs.entries()]
    .filter(([option, p]) => option !== NONE_OPTION && (p >= PROBABILITY_FLOOR || option === answer.choice))
    .sort((a, b) => b[1] - a[1] || (a[0] === answer.choice ? -1 : b[0] === answer.choice ? 1 : 0));
  return { status: 'ok', ranked: ordered.map(([option]) => optionToName.get(option)!), weights: ordered.map(([, p]) => p), confidence };
}

/** Leading entries until their cumulative weight reaches `mass` (at most `maxKeep`). */
export function takeByMass(ranked: string[], weights: number[], mass: number, maxKeep: number): string[] {
  const kept: string[] = [];
  let cumulative = 0;
  for (let i = 0; i < ranked.length && kept.length < maxKeep; i++) {
    kept.push(ranked[i]!);
    cumulative += weights[i] ?? 0;
    if (cumulative >= mass) break;
  }
  return kept;
}

/** Decided names first (in decided order), then the rest in their original order. */
export function mergeRanking(original: string[], decided: string[], limit: number): string[] {
  const known = new Set(original);
  const head = [...new Set(decided.filter((n) => known.has(n)))];
  const headSet = new Set(head);
  return [...head, ...original.filter((n) => !headSet.has(n))].slice(0, limit);
}

export type GateOutcome = 'allow' | 'confirm' | 'deny';

export interface GateInterpretation {
  /** Undefined when the answer is unusable; the caller applies the tenant's `onError`. */
  outcome?: GateOutcome;
  reason: 'ok' | 'refusal' | 'invalid';
  confidence?: Confidence;
}

/** Risk = the larger of `risky` and `off_intent`; a refusal on either asks for confirmation. */
export function interpretGate(r: DecisionResponse, t: { confirmAt: number; denyAt: number }): GateInterpretation {
  const risky = r.answers.risky;
  const offIntent = r.answers.off_intent;
  if (risky?.type === 'refusal' || offIntent?.type === 'refusal') return { outcome: 'confirm', reason: 'refusal' };
  if (risky?.type !== 'predicate') return { reason: 'invalid' };
  const p = Math.max(risky.probability, offIntent?.type === 'predicate' ? offIntent.probability : 0);
  const outcome: GateOutcome = p >= t.denyAt ? 'deny' : p >= t.confirmAt ? 'confirm' : 'allow';
  return { outcome, reason: 'ok', confidence: confidenceBucket(Math.abs(p - 0.5) * 2) };
}

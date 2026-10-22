import { z } from 'zod';
import type { DecisionAnswer, DecisionQuestion } from '../model';

const probabilityList = z.array(
  z.looseObject({
    value: z.string().optional(),
    label: z.string().optional(),
    choice: z.string().optional(),
    probability: z.number(),
  }),
);

/** Accepts `{option: p}` or `[{value|label|choice, probability}]`; anything else is undefined. */
export function readProbabilities(raw: unknown): Record<string, number> | undefined {
  const asRecord = z.record(z.string(), z.number()).safeParse(raw);
  if (asRecord.success) return asRecord.data;
  const asList = probabilityList.safeParse(raw);
  if (!asList.success) return undefined;
  const out: Record<string, number> = {};
  for (const p of asList.data) {
    const key = p.value ?? p.label ?? p.choice;
    if (key !== undefined) out[key] = p.probability;
  }
  return out;
}

const isProbability = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/**
 * Reads one raw answer as the type the question asked for. Returns undefined when the answer is
 * malformed, so the caller treats it as missing instead of failing the whole batch.
 */
export function readAnswer(question: DecisionQuestion, raw: Record<string, unknown>, probabilityKeys: string[]): DecisionAnswer | undefined {
  if (raw.refusal !== undefined && raw.refusal !== null && raw.refusal !== false) return { type: 'refusal' };
  const confidence = isProbability(raw.confidence) ? raw.confidence : undefined;
  if (question.type === 'predicate') {
    const p = probabilityKeys.map((k) => raw[k]).find(isProbability);
    return p === undefined ? undefined : { type: 'predicate', probability: p };
  }
  const probabilities = readProbabilities(raw.probabilities) ?? {};
  if (question.type === 'choice') {
    if (typeof raw.choice !== 'string') return undefined;
    return { type: 'choice', choice: raw.choice, probabilities, ...(confidence !== undefined ? { confidence } : {}) };
  }
  if (typeof raw.score !== 'number' || !Number.isFinite(raw.score)) return undefined;
  return { type: 'score', score: raw.score, probabilities, ...(confidence !== undefined ? { confidence } : {}) };
}

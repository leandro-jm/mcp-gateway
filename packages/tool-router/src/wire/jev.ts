import { z } from 'zod';
import { DecisionWireError, type DecisionAnswer, type DecisionRequest, type DecisionResponse } from '../model';
import { readAnswer } from './common';

/**
 * Body of `POST /v1/systemone` (TypeSafe Jev, 2026-10 docs). Questions are a map keyed by id;
 * `predicate` is called `noul`, and choice/score options are `criteria` (option → description).
 * The shapes come from the public docs only, so this adapter is experimental (ADR-025).
 */
export function toJevBody(req: DecisionRequest, model: string): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const q of req.questions) {
    if (q.type === 'predicate') questions[q.name] = { type: 'noul', instructions: q.instructions };
    else if (q.type === 'choice') questions[q.name] = { type: 'choice', instructions: q.instructions, criteria: Object.fromEntries(q.choices.map((c) => [c.value, c.description])) };
    else questions[q.name] = { type: 'score', instructions: q.instructions, criteria: Object.fromEntries(q.levels.map((l) => [l.label, l.description])) };
  }
  return { model, state: req.input, questions };
}

const responseSchema = z.looseObject({
  answers: z.record(z.string(), z.looseObject({})),
  usage: z.looseObject({ input_tokens: z.number().optional() }).optional(),
});

export function fromJevBody(json: unknown, req: DecisionRequest): DecisionResponse {
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) throw new DecisionWireError('jev: unexpected response shape');
  const answers: Record<string, DecisionAnswer> = {};
  for (const q of req.questions) {
    const raw = parsed.data.answers[q.name] as Record<string, unknown> | undefined;
    const answer = raw ? readAnswer(q, raw, ['probability', 'answer']) : undefined;
    if (answer) answers[q.name] = answer;
  }
  const inputTokens = parsed.data.usage?.input_tokens;
  return { answers, ...(inputTokens !== undefined ? { inputTokens } : {}) };
}

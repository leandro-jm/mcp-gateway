import { z } from 'zod';
import { DecisionWireError, type DecisionAnswer, type DecisionRequest, type DecisionResponse } from '../model';
import { readAnswer } from './common';

/** Body of `POST /v1/decisions` (OpenAI Decisions API, public beta 2026-10). */
export function toOpenAiDecisionsBody(req: DecisionRequest, model: string): Record<string, unknown> {
  return {
    model,
    input: req.input,
    questions: req.questions.map((q) => {
      const base = { name: q.name, type: q.type, instructions: q.instructions };
      if (q.type === 'choice') return { ...base, choices: q.choices.map((c) => ({ value: c.value, description: c.description })) };
      if (q.type === 'score') return { ...base, levels: q.levels.map((l) => ({ label: l.label, description: l.description })) };
      return base;
    }),
  };
}

const responseSchema = z.looseObject({
  answers: z.array(z.looseObject({ name: z.string() })),
  usage: z.looseObject({ input_tokens: z.number().optional() }).optional(),
});

/** Parses the response; answers come back as an array, each echoing its question `name`. */
export function fromOpenAiDecisionsBody(json: unknown, req: DecisionRequest): DecisionResponse {
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) throw new DecisionWireError('openai-decisions: unexpected response shape');
  const byName = new Map(parsed.data.answers.map((a) => [a.name, a as Record<string, unknown>]));
  const answers: Record<string, DecisionAnswer> = {};
  for (const q of req.questions) {
    const raw = byName.get(q.name);
    const answer = raw ? readAnswer(q, raw, ['probability']) : undefined;
    if (answer) answers[q.name] = answer;
  }
  const inputTokens = parsed.data.usage?.input_tokens;
  return { answers, ...(inputTokens !== undefined ? { inputTokens } : {}) };
}

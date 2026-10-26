import { describe, expect, it } from 'vitest';
import { DecisionWireError, type DecisionRequest } from './model';
import { fromJevBody, toJevBody } from './wire/jev';
import { fromOpenAiDecisionsBody, toOpenAiDecisionsBody } from './wire/openai';

const req: DecisionRequest = {
  input: 'state',
  questions: [
    { name: 'risky', type: 'predicate', instructions: 'Is it risky?' },
    { name: 'tool', type: 'choice', instructions: 'Which tool?', choices: [{ value: 't1', description: 'A' }, { value: 'none', description: 'None' }] },
    { name: 'level', type: 'score', instructions: 'How bad?', levels: [{ label: 'low', description: 'L' }, { label: 'high', description: 'H' }] },
  ],
};

describe('OpenAI Decisions wire (F19.2)', () => {
  it('maps questions to the array body', () => {
    expect(toOpenAiDecisionsBody(req, 'gpt-6-luna')).toEqual({
      model: 'gpt-6-luna',
      input: 'state',
      questions: [
        { name: 'risky', type: 'predicate', instructions: 'Is it risky?' },
        { name: 'tool', type: 'choice', instructions: 'Which tool?', choices: [{ value: 't1', description: 'A' }, { value: 'none', description: 'None' }] },
        { name: 'level', type: 'score', instructions: 'How bad?', levels: [{ label: 'low', description: 'L' }, { label: 'high', description: 'H' }] },
      ],
    });
  });

  it('reads answers by name, per-question refusals and token usage', () => {
    const res = fromOpenAiDecisionsBody(
      {
        answers: [
          { name: 'tool', choice: 't1', probabilities: { t1: 0.8, none: 0.2 }, confidence: 0.8 },
          { name: 'risky', refusal: 'I cannot help with that' },
          { name: 'level', score: 0.4, probabilities: [{ label: 'low', probability: 0.6 }, { label: 'high', probability: 0.4 }] },
        ],
        usage: { input_tokens: 120 },
      },
      req,
    );
    expect(res).toEqual({
      answers: {
        tool: { type: 'choice', choice: 't1', probabilities: { t1: 0.8, none: 0.2 }, confidence: 0.8 },
        risky: { type: 'refusal' },
        level: { type: 'score', score: 0.4, probabilities: { low: 0.6, high: 0.4 } },
      },
      inputTokens: 120,
    });
  });

  it('drops malformed or unknown answers instead of failing the batch', () => {
    const res = fromOpenAiDecisionsBody({ answers: [{ name: 'risky', probability: 1.7 }, { name: 'tool' }, { name: 'other', probability: 0.1 }] }, req);
    expect(res.answers).toEqual({});
  });

  it('rejects a body that is not a decisions response', () => {
    expect(() => fromOpenAiDecisionsBody({ output: 'text' }, req)).toThrow(DecisionWireError);
  });
});

describe('Jev wire (F19.2)', () => {
  it('maps questions to the keyed map with noul and criteria', () => {
    expect(toJevBody(req, 'jev-latest')).toEqual({
      model: 'jev-latest',
      state: 'state',
      questions: {
        risky: { type: 'noul', instructions: 'Is it risky?' },
        tool: { type: 'choice', instructions: 'Which tool?', criteria: { t1: 'A', none: 'None' } },
        level: { type: 'score', instructions: 'How bad?', criteria: { low: 'L', high: 'H' } },
      },
    });
  });

  it('reads answers keyed by question id', () => {
    const res = fromJevBody(
      { answers: { risky: { probability: 0.3 }, tool: { choice: 'none', probabilities: { t1: 0.1, none: 0.9 }, confidence: 0.9 }, level: { score: 1, probabilities: { low: 0, high: 1 } } } },
      req,
    );
    expect(res.answers).toEqual({
      risky: { type: 'predicate', probability: 0.3 },
      tool: { type: 'choice', choice: 'none', probabilities: { t1: 0.1, none: 0.9 }, confidence: 0.9 },
      level: { type: 'score', score: 1, probabilities: { low: 0, high: 1 } },
    });
  });

  it('round-trips the same neutral request through both providers', () => {
    const openai = fromOpenAiDecisionsBody({ answers: [{ name: 'risky', probability: 0.42 }] }, req);
    const jev = fromJevBody({ answers: { risky: { probability: 0.42 } } }, req);
    expect(jev.answers).toEqual(openai.answers);
  });

  it('rejects a body without answers', () => {
    expect(() => fromJevBody({ answers: [] }, req)).toThrow(DecisionWireError);
  });
});

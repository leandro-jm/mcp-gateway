/**
 * Provider-neutral model of a decision request (ADR-025). Decision models answer typed questions
 * with calibrated probabilities instead of generated text; the wire modules map this model to the
 * OpenAI Decisions API and to TypeSafe Jev.
 */

export type DecisionProviderId = 'openai_decisions' | 'jev';

export const DECISION_PROVIDERS: readonly DecisionProviderId[] = ['openai_decisions', 'jev'];

export interface ChoiceOption {
  value: string;
  description: string;
}

export interface ScoreLevel {
  label: string;
  description: string;
}

export type DecisionQuestion =
  | { name: string; type: 'predicate'; instructions: string }
  | { name: string; type: 'choice'; instructions: string; choices: ChoiceOption[] }
  | { name: string; type: 'score'; instructions: string; levels: ScoreLevel[] };

export interface DecisionRequest {
  /** State the questions are about (OpenAI `input`, Jev `state`). */
  input: string;
  questions: DecisionQuestion[];
}

export type DecisionAnswer =
  | { type: 'predicate'; probability: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence?: number }
  /** `score` is the probability-weighted level index, so it can fall between levels. */
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence?: number }
  /** The provider declined this question; the refusal text is never kept. */
  | { type: 'refusal' };

export interface DecisionResponse {
  /** Answers by question name; a missing or malformed answer is absent. */
  answers: Record<string, DecisionAnswer>;
  inputTokens?: number;
}

export interface DecisionProvider {
  readonly id: DecisionProviderId;
  readonly model: string;
  decide(req: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse>;
  /** Smallest possible decision, used by the "test connection" endpoint. */
  ping(signal?: AbortSignal): Promise<void>;
}

export const DEFAULT_DECISION_MODELS: Record<DecisionProviderId, string> = {
  openai_decisions: 'gpt-6-luna',
  jev: 'jev-latest',
};

/**
 * Per-provider limits. Jev documents 255 options per choice and a 32K-token context; OpenAI does
 * not document a maximum number of choices, so 64 is a conservative assumption (ADR-025).
 */
export const PROVIDER_LIMITS: Record<DecisionProviderId, { maxChoices: number; maxInputChars: number }> = {
  openai_decisions: { maxChoices: 64, maxInputChars: 200_000 },
  jev: { maxChoices: 255, maxInputChars: 80_000 },
};

/** The provider body did not match the expected wire shape. */
export class DecisionWireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionWireError';
  }
}

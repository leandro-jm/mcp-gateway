/** Guardrails of the natural-language composer (ADR-015). */
export const COMPOSER_LIMITS = {
  /** Characters of the user request and of a refinement. */
  maxPromptChars: 2000,
  /** Bytes of a previous definition sent back for refinement. */
  maxPreviousBytes: 20_000,
  /** Tools sent to the model as candidates. */
  maxCandidates: 15,
  /** Extra attempts after an invalid proposal. */
  maxRepairs: 2,
  /** Characters of a tool description in the prompt. */
  maxDescriptionChars: 300,
} as const;

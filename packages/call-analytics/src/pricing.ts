/** Money value of estimated tokens (FinOps view, ADR-016 §11): an estimate, never a bill. */
export interface TokenPricing {
  currency: string;
  /** Price of one million model input tokens. */
  inputPerMTok: number;
}

export function priceTokens(tokens: number, pricing: TokenPricing): number {
  return Math.round((tokens / 1_000_000) * pricing.inputPerMTok * 100) / 100;
}

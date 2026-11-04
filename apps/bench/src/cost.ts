import type { TokenUsage } from './types';

/** USD per million tokens; `maxPromptTokens: null` is the open-ended last tier. */
export interface PriceTier {
  maxPromptTokens: number | null;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export type PriceTable = Record<string, PriceTier[]>;

const M = 1_000_000;

export const promptTokens = (u: TokenUsage) => u.input + u.cacheRead + u.cacheWrite;

/** A request is priced by its full prompt length, cache reads and writes included. */
export function tierFor(tiers: PriceTier[], prompt: number): PriceTier {
  const tier = tiers.find((t) => t.maxPromptTokens === null || prompt <= t.maxPromptTokens);
  if (!tier) throw new Error(`no price tier for a ${prompt}-token prompt`);
  return tier;
}

export function pricesFor(table: PriceTable, model: string): PriceTier[] {
  const tiers = table[model];
  if (!tiers?.length) throw new Error(`no prices for model ${model} in prices.json`);
  return tiers;
}

/**
 * Cost of one model request. `uncached` reprices cache reads and writes as plain input: what the
 * same request would cost with caching off (the model's behavior does not depend on the cache).
 */
export function turnCost(u: TokenUsage, tiers: PriceTier[]): { cached: number; uncached: number } {
  const t = tierFor(tiers, promptTokens(u));
  const out = u.output * t.output;
  return {
    cached: (u.input * t.input + u.cacheWrite * t.cacheWrite + u.cacheRead * t.cacheRead + out) / M,
    uncached: (promptTokens(u) * t.input + out) / M,
  };
}

export function runCost(usages: TokenUsage[], tiers: PriceTier[]): { cached: number; uncached: number } {
  return usages.reduce(
    (acc, u) => {
      const c = turnCost(u, tiers);
      return { cached: acc.cached + c.cached, uncached: acc.uncached + c.uncached };
    },
    { cached: 0, uncached: 0 },
  );
}

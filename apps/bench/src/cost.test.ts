import { describe, expect, it } from 'vitest';
import { pricesFor, runCost, tierFor, turnCost, type PriceTier } from './cost';

const haiku: PriceTier[] = [
  { maxPromptTokens: 100_000, input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  { maxPromptTokens: null, input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 },
];
const sonnet: PriceTier[] = [{ maxPromptTokens: null, input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 }];

describe('cost', () => {
  it('picks the tier by the full prompt length, cache included', () => {
    expect(tierFor(haiku, 100_000).input).toBe(0.1);
    expect(tierFor(haiku, 100_001).input).toBe(0.5);
    const big = turnCost({ input: 1_000, cacheRead: 99_500, cacheWrite: 0, output: 0 }, haiku);
    expect(big.cached).toBeCloseTo((1_000 * 0.5 + 99_500 * 0.05) / 1e6, 10);
  });

  it('prices cache reads and writes, and reprices them as input when uncached', () => {
    const c = turnCost({ input: 2_000, cacheRead: 40_000, cacheWrite: 1_000, output: 500 }, sonnet);
    expect(c.cached).toBeCloseTo((2_000 * 2 + 40_000 * 0.1 + 1_000 * 2.5 + 500 * 10) / 1e6, 10);
    expect(c.uncached).toBeCloseTo((43_000 * 2 + 500 * 10) / 1e6, 10);
  });

  it('sums a run and rejects unknown models', () => {
    const u = { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 };
    expect(runCost([u, u], sonnet).cached).toBeCloseTo(4, 10);
    expect(() => pricesFor({ 'claude-sonnet-5-5': sonnet }, 'other')).toThrow(/no prices/);
  });
});

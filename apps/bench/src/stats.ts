/** Nearest-rank quantile, as in `apps/gateway/scripts/router-eval.ts`. */
export const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] ?? 0;

export const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/** Wilson score interval for k successes in n trials (95% by default). */
export function wilson(k: number, n: number, z = 1.96): { p: number; low: number; high: number } {
  if (n === 0) return { p: 0, low: 0, high: 0 };
  const p = k / n;
  const z2 = z * z;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { p, low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

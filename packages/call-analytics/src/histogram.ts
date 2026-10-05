/**
 * Latency histogram edges in milliseconds: the same edges as the Prometheus histograms
 * (`LATENCY_BUCKETS`, in seconds), plus an overflow bucket. Rollups store non-cumulative counts.
 */
export const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000] as const;

/** Index of the bucket a value falls in (`LATENCY_BUCKETS_MS.length` = overflow). */
export function bucketIndex(ms: number, edges: readonly number[] = LATENCY_BUCKETS_MS): number {
  const i = edges.findIndex((e) => ms <= e);
  return i === -1 ? edges.length : i;
}

/** Adds non-cumulative histograms element-wise. */
export function mergeHistograms(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(Math.max(a.length, b.length)).fill(0);
  for (let i = 0; i < out.length; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0);
  return out;
}

/**
 * Quantile estimate from a non-cumulative histogram, interpolating linearly inside the bucket
 * (like Prometheus `histogram_quantile`). The overflow bucket reports its lower edge.
 */
export function histogramQuantile(q: number, counts: readonly number[], edges: readonly number[] = LATENCY_BUCKETS_MS): number | null {
  const total = counts.reduce((a, n) => a + n, 0);
  if (!total) return null;
  const rank = Math.min(Math.max(q, 0), 1) * total;
  let seen = 0;
  for (let i = 0; i < counts.length; i++) {
    const n = counts[i] ?? 0;
    if (seen + n >= rank && n > 0) {
      if (i >= edges.length) return edges[edges.length - 1]!;
      const lower = i === 0 ? 0 : edges[i - 1]!;
      const upper = edges[i]!;
      return lower + (upper - lower) * ((rank - seen) / n);
    }
    seen += n;
  }
  return edges[edges.length - 1]!;
}

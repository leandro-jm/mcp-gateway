/**
 * Volume anomalies (security view): the last complete hour of each key (client, agent) against
 * the same hour of the week in the previous weeks. A z-score with a floor on the deviation keeps
 * quiet keys from alerting on noise.
 */
export interface HourlyCount {
  key: string;
  hour: Date;
  calls: number;
}

export interface Anomaly {
  key: string;
  hour: string;
  calls: number;
  baseline: number;
  score: number;
}

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;

export function anomalyScores(rows: HourlyCount[], now: Date, opts: { weeks?: number; minCalls?: number; threshold?: number } = {}): Anomaly[] {
  const weeks = opts.weeks ?? 4;
  const minCalls = opts.minCalls ?? 10;
  const threshold = opts.threshold ?? 3;
  const target = Math.floor(now.getTime() / HOUR) * HOUR - HOUR; // last complete hour
  const byKey = new Map<string, Map<number, number>>();
  for (const r of rows) {
    const m = byKey.get(r.key) ?? new Map<number, number>();
    const h = Math.floor(r.hour.getTime() / HOUR) * HOUR;
    m.set(h, (m.get(h) ?? 0) + r.calls);
    byKey.set(r.key, m);
  }
  const out: Anomaly[] = [];
  for (const [key, hours] of byKey) {
    const current = hours.get(target) ?? 0;
    if (current < minCalls) continue;
    const history = Array.from({ length: weeks }, (_, i) => hours.get(target - (i + 1) * WEEK) ?? 0);
    const mean = history.reduce((a, n) => a + n, 0) / weeks;
    const std = Math.sqrt(history.reduce((a, n) => a + (n - mean) ** 2, 0) / weeks);
    const score = (current - mean) / Math.max(std, Math.sqrt(Math.max(mean, 1)), 1);
    if (score >= threshold) out.push({ key, hour: new Date(target).toISOString(), calls: current, baseline: Math.round(mean * 10) / 10, score: Math.round(score * 10) / 10 });
  }
  return out.sort((a, b) => b.score - a.score);
}

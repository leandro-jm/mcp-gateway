import type { ReactNode } from 'react';
import { Sparkline } from './Sparkline';

/** Big number with a label, optional hint and trend (values per bucket, with their labels). */
export function StatCard({
  label,
  value,
  hint,
  trend,
  trendLabels,
  formatTrend,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  trend?: Array<number | null>;
  trendLabels?: string[];
  formatTrend?: (v: number) => string;
  tone?: 'good' | 'bad';
}) {
  const points = trend?.map((v) => v ?? 0);
  return (
    <div className={`stat-card ${tone ?? ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {points && <Sparkline values={points} labels={trendLabels} format={formatTrend} label={label} />}
      {hint && <div className="stat-hint muted">{hint}</div>}
    </div>
  );
}

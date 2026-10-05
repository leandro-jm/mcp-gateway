import type { ReactNode } from 'react';
import { Sparkline } from './Sparkline';

/** Big number with a label, optional hint and trend. */
export function StatCard({ label, value, hint, trend, tone }: { label: string; value: ReactNode; hint?: ReactNode; trend?: number[]; tone?: 'good' | 'bad' }) {
  return (
    <div className={`stat-card ${tone ?? ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {trend && <Sparkline values={trend} />}
      {hint && <div className="stat-hint muted">{hint}</div>}
    </div>
  );
}

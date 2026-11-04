import type { CSSProperties } from 'react';
import { useT } from '../i18n';

// cell widths cycle so rows look like text, not a grid of identical bars
const WIDTHS = ['72%', '48%', '60%', '36%', '54%', '42%', '66%'];

/** One shimmering bar (ADR-029). Decorative: the surrounding region announces the loading. */
export function Skeleton({ width = '100%', height = 12, style }: { width?: number | string; height?: number; style?: CSSProperties }) {
  return <span className="skeleton" aria-hidden="true" style={{ width, height, ...style }} />;
}

function Status() {
  const t = useT();
  return (
    <span className="sr-only" role="status">
      {t('common.loading')}
    </span>
  );
}

/** Placeholder rows for a `<tbody>` while its data loads; same column count, so the layout does not jump. */
export function SkeletonRows({ cols, rows = 6 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} className="skeleton-row" aria-hidden="true">
          {Array.from({ length: cols }, (_, c) => (
            <td key={c}>
              <Skeleton width={WIDTHS[(r + c * 3) % WIDTHS.length]} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** A whole table placeholder, for places that render no table until the data arrives. */
export function TableSkeleton({ cols, rows = 6, className = 'table' }: { cols: number; rows?: number; className?: string }) {
  return (
    <div aria-busy="true">
      <Status />
      <table className={className} aria-hidden="true">
        <thead>
          <tr>
            {Array.from({ length: cols }, (_, c) => (
              <th key={c}>
                <Skeleton width={c === 0 ? 96 : 64} height={10} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <SkeletonRows cols={cols} rows={rows} />
        </tbody>
      </table>
    </div>
  );
}

/** Lines of text inside a panel, drawer or form. */
export function TextSkeleton({ lines = 4 }: { lines?: number }) {
  return (
    <div className="skeleton-text" aria-busy="true">
      <Status />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? '40%' : WIDTHS[i % WIDTHS.length]} />
      ))}
    </div>
  );
}

/** A card with a title and a chart-shaped body. */
export function ChartSkeleton({ height = 220 }: { height?: number }) {
  return (
    <div className="chart skeleton-card" aria-busy="true">
      <Status />
      <Skeleton width={140} height={14} />
      <Skeleton height={height} style={{ marginTop: 12 }} />
    </div>
  );
}

/** A row of stat cards. */
export function StatsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="stat-grid" aria-busy="true">
      <Status />
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="stat-card">
          <Skeleton width="55%" height={12} />
          <Skeleton width="40%" height={28} style={{ marginTop: 6 }} />
          <Skeleton width="70%" height={10} style={{ marginTop: 4 }} />
        </div>
      ))}
    </div>
  );
}

/** Dashboard tab placeholder: stat cards, then charts in two columns. */
export function DashboardSkeleton({ stats = 4, charts = 2 }: { stats?: number; charts?: number }) {
  return (
    <>
      {stats > 0 && <StatsSkeleton count={stats} />}
      <div className="chart-grid-2">
        {Array.from({ length: charts }, (_, i) => (
          <ChartSkeleton key={i} />
        ))}
      </div>
    </>
  );
}

/** Route placeholder while a lazy page loads: header, toolbar and a table. */
export function PageSkeleton() {
  return (
    <div aria-busy="true">
      <div className="page-head">
        <div style={{ display: 'grid', gap: 10 }}>
          <Skeleton width={180} height={22} />
          <Skeleton width={320} height={12} />
        </div>
      </div>
      <div className="content">
        <div className="toolbar">
          <Skeleton width={360} height={34} style={{ maxWidth: '100%', borderRadius: 'var(--radius)' }} />
        </div>
        <TableSkeleton cols={5} rows={8} />
      </div>
    </div>
  );
}

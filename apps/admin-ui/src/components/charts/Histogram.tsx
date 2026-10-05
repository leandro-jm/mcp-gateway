import { ChartFrame, niceMax, SERIES_COLORS } from './ChartFrame';

/** Vertical bars over ordered buckets (e.g. latency histogram). */
export function Histogram({ title, desc, buckets }: { title: string; desc?: string; buckets: Array<{ label: string; count: number }> }) {
  const max = niceMax(Math.max(0, ...buckets.map((b) => b.count)));
  const W = 640;
  const H = 160;
  const bw = W / Math.max(buckets.length, 1);
  return (
    <ChartFrame title={title} desc={desc} table={{ columns: ['bucket', 'count'], rows: buckets.map((b) => [b.label, b.count]) }} empty={!buckets.some((b) => b.count)}>
      {({ titleId, descId }) => (
        <svg className="chart-svg" viewBox={`0 0 ${W} ${H + 20}`} role="img" aria-labelledby={`${titleId} ${descId}`}>
          <title id={titleId}>{title}</title>
          {buckets.map((b, i) => {
            const h = (H * b.count) / max;
            return (
              <g key={b.label}>
                <rect x={i * bw + 2} y={H - h} width={bw - 4} height={h} fill={SERIES_COLORS[0]}>
                  <title>{`${b.label}: ${b.count}`}</title>
                </rect>
                <text x={i * bw + bw / 2} y={H + 14} textAnchor="middle" className="chart-axis">
                  {b.label}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </ChartFrame>
  );
}

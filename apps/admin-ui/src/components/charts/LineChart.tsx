import { ChartFrame, niceMax, SERIES_COLORS } from './ChartFrame';

export interface LineSeries {
  name: string;
  points: Array<{ x: string; y: number | null }>;
}

const W = 640;
const H = 220;
const PAD = { l: 48, r: 12, t: 12, b: 28 };

/** Time series (one or more lines over the same x values). */
export function LineChart({ title, desc, series, formatY = String, formatX = (x: string) => x }: { title: string; desc?: string; series: LineSeries[]; formatY?: (v: number) => string; formatX?: (x: string) => string }) {
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort();
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.y ?? 0))));
  const x = (i: number) => PAD.l + (xs.length <= 1 ? (W - PAD.l - PAD.r) / 2 : (i / (xs.length - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const labelEvery = Math.max(1, Math.ceil(xs.length / 6));
  const table = {
    columns: ['x', ...series.map((s) => s.name)],
    rows: xs.map((xv) => [formatX(xv), ...series.map((s) => s.points.find((p) => p.x === xv)?.y ?? null)]),
  };
  return (
    <ChartFrame title={title} desc={desc} table={table} empty={!xs.length}>
      {({ titleId, descId }) => (
        <>
          <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${titleId} ${descId}`}>
            <title id={titleId}>{title}</title>
            {ticks.map((v) => (
              <g key={v}>
                <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="chart-grid" />
                <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" className="chart-axis">
                  {formatY(v)}
                </text>
              </g>
            ))}
            {xs.map((xv, i) =>
              i % labelEvery === 0 ? (
                <text key={xv} x={x(i)} y={H - 8} textAnchor="middle" className="chart-axis">
                  {formatX(xv)}
                </text>
              ) : null,
            )}
            {series.map((s, si) => {
              const pts = xs.map((xv, i) => ({ i, v: s.points.find((p) => p.x === xv)?.y ?? null }));
              const d = pts.filter((p) => p.v !== null).map((p, k) => `${k ? 'L' : 'M'}${x(p.i)},${y(p.v!)}`).join(' ');
              return (
                <g key={s.name} style={{ color: SERIES_COLORS[si % SERIES_COLORS.length] }}>
                  <path d={d} className="chart-line" />
                  {pts.filter((p) => p.v !== null).map((p) => (
                    <circle key={p.i} cx={x(p.i)} cy={y(p.v!)} r={2.5} className="chart-dot">
                      <title>{`${s.name} · ${formatX(xs[p.i]!)}: ${formatY(p.v!)}`}</title>
                    </circle>
                  ))}
                </g>
              );
            })}
          </svg>
          {series.length > 1 && (
            <div className="chart-legend">
              {series.map((s, si) => (
                <span key={s.name}>
                  <i style={{ background: SERIES_COLORS[si % SERIES_COLORS.length] }} />
                  {s.name}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </ChartFrame>
  );
}

import { ChartFrame, niceMax, SERIES_COLORS } from './ChartFrame';

export interface Bar {
  label: string;
  value: number;
  hint?: string;
}

/** Horizontal bars for categorical rankings (tools, sources, detectors). */
export function BarChart({ title, desc, data, format = String, color = 0 }: { title: string; desc?: string; data: Bar[]; format?: (v: number) => string; color?: number }) {
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const rowH = 26;
  const W = 640;
  const labelW = 220;
  const H = Math.max(rowH, data.length * rowH);
  return (
    <ChartFrame title={title} desc={desc} table={{ columns: ['label', 'value'], rows: data.map((d) => [d.label, d.value]) }} empty={!data.length}>
      {({ titleId, descId }) => (
        <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${titleId} ${descId}`}>
          <title id={titleId}>{title}</title>
          {data.map((d, i) => {
            const w = ((W - labelW - 70) * d.value) / max;
            return (
              <g key={d.label} transform={`translate(0, ${i * rowH})`}>
                <text x={labelW - 8} y={rowH / 2 + 4} textAnchor="end" className="chart-label">
                  {d.label.length > 32 ? `${d.label.slice(0, 31)}…` : d.label}
                </text>
                <rect x={labelW} y={5} width={Math.max(w, d.value > 0 ? 2 : 0)} height={rowH - 10} fill={SERIES_COLORS[color % SERIES_COLORS.length]}>
                  <title>{`${d.label}: ${format(d.value)}${d.hint ? ` · ${d.hint}` : ''}`}</title>
                </rect>
                <text x={labelW + w + 6} y={rowH / 2 + 4} className="chart-axis">
                  {format(d.value)}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </ChartFrame>
  );
}

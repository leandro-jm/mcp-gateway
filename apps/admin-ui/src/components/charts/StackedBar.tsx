import { ChartFrame, SERIES_COLORS } from './ChartFrame';

/** One horizontal bar split in segments (e.g. a call's latency per stage). */
export function StackedBar({ title, desc, segments, format = String }: { title: string; desc?: string; segments: Array<{ label: string; value: number }>; format?: (v: number) => string }) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  const W = 640;
  let x = 0;
  return (
    <ChartFrame title={title} desc={desc} table={{ columns: ['label', 'value'], rows: segments.map((s) => [s.label, s.value]) }} empty={!total}>
      {({ titleId, descId }) => (
        <>
          <svg className="chart-svg" viewBox={`0 0 ${W} 28`} role="img" aria-labelledby={`${titleId} ${descId}`}>
            <title id={titleId}>{title}</title>
            {segments.map((s, i) => {
              const w = (W * s.value) / total;
              const rect = (
                <rect key={s.label} x={x} y={4} width={Math.max(w, 0)} height={20} fill={SERIES_COLORS[i % SERIES_COLORS.length]}>
                  <title>{`${s.label}: ${format(s.value)}`}</title>
                </rect>
              );
              x += w;
              return rect;
            })}
          </svg>
          <div className="chart-legend">
            {segments.map((s, i) => (
              <span key={s.label}>
                <i style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
                {s.label} <span className="mono">{format(s.value)}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </ChartFrame>
  );
}

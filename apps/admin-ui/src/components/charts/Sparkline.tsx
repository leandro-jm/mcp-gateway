/** Tiny inline trend line (decorative: the number next to it carries the meaning). */
export function Sparkline({ values, width = 96, height = 24 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${(i / (values.length - 1)) * width},${height - ((v - min) / (max - min || 1)) * height}`).join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="sparkline">
      <path d={d} />
    </svg>
  );
}

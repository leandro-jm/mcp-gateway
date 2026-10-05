import type React from 'react';
/** Dithered (line-based) isometric cube, like the empty-state illustration of the reference design. */
export function CubeArt({ size = 220 }: { size?: number }) {
  const lines: React.ReactElement[] = [];
  const w = 200;
  const top = (y: number) => ({ x1: 100 - (y * 100) / 50, x2: 100 + (y * 100) / 50 });
  // top face (rhombus) with dense horizontal lines
  for (let y = 0; y <= 50; y += 1.6) {
    const t = y <= 25 ? top(y) : top(50 - y);
    lines.push(<line key={`t${y}`} x1={t.x1} y1={y} x2={t.x2} y2={y} stroke="var(--art-1)" strokeOpacity={0.55} strokeWidth={0.7} />);
  }
  // side faces: darker hatching
  for (let y = 25; y <= 150; y += 2.2) {
    const fade = Math.max(0.08, 0.5 - (y - 25) / 300);
    lines.push(<line key={`l${y}`} x1={0} y1={y} x2={100} y2={y + 25} stroke="var(--art-2)" strokeOpacity={fade} strokeWidth={0.7} />);
    lines.push(<line key={`r${y}`} x1={100} y1={y + 25} x2={200} y2={y} stroke="var(--art-3)" strokeOpacity={fade * 0.8} strokeWidth={0.7} />);
  }
  return (
    <svg width={size} height={(size * 180) / w} viewBox="-2 -2 204 182" aria-hidden="true">
      {lines}
      <polyline points="0,150 100,175 200,150" fill="none" stroke="var(--art-2)" strokeOpacity={0.5} strokeDasharray="1.2 2.2" strokeWidth={0.8} />
    </svg>
  );
}

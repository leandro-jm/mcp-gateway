import { useId, type CSSProperties, type ReactElement } from 'react';

const vars = (v: Record<string, string | number>) => v as CSSProperties;

/**
 * The dithered isometric cube of the Admin UI empty state (apps/admin-ui/src/components/CubeArt.tsx),
 * animated: hatch lines draw in one after another, the edges light up in the accent color and a scan
 * band sweeps the faces. CSS handles the motion, so `prefers-reduced-motion` shows the final drawing.
 */
export function CubeArt({ size = 360 }: { size?: number }) {
  const id = useId().replace(/:/g, '');
  const lines: ReactElement[] = [];
  let i = 0;
  const top = (y: number) => ({ x1: 100 - (y * 100) / 50, x2: 100 + (y * 100) / 50 });
  // top face (rhombus) with dense horizontal lines
  for (let y = 0; y <= 50; y += 1.6) {
    const t = y <= 25 ? top(y) : top(50 - y);
    lines.push(<line key={`t${y}`} x1={t.x1} y1={y} x2={t.x2} y2={y} pathLength={1} stroke="var(--art-1)" strokeOpacity={0.55} strokeWidth={0.7} style={vars({ '--i': i++ })} />);
  }
  // side faces: darker hatching that fades towards the base
  for (let y = 25; y <= 150; y += 2.2) {
    const fade = Math.max(0.08, 0.5 - (y - 25) / 300);
    const n = i++;
    lines.push(<line key={`l${y}`} x1={0} y1={y} x2={100} y2={y + 25} pathLength={1} stroke="var(--art-2)" strokeOpacity={fade} strokeWidth={0.7} style={vars({ '--i': n })} />);
    lines.push(<line key={`r${y}`} x1={200} y1={y} x2={100} y2={y + 25} pathLength={1} stroke="var(--art-3)" strokeOpacity={fade * 0.8} strokeWidth={0.7} style={vars({ '--i': n })} />);
  }
  const silhouette = '100,0 200,25 200,150 100,175 0,150 0,25';
  return (
    <svg className="cube" width={size} height={(size * 180) / 200} viewBox="-2 -2 204 182" aria-hidden="true" style={vars({ '--n': i })}>
      <defs>
        <clipPath id={`clip${id}`}>
          <polygon points={silhouette} />
        </clipPath>
        <linearGradient id={`scan${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0" />
          <stop offset="0.85" stopColor="var(--accent)" stopOpacity="0.28" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0.9" />
        </linearGradient>
      </defs>
      <g className="cube-lines">{lines}</g>
      <g clipPath={`url(#clip${id})`}>
        <rect className="cube-scan" x="0" y="-36" width="200" height="36" fill={`url(#scan${id})`} />
      </g>
      <polyline className="cube-edge" points="0,25 100,50 200,25" pathLength={1} />
      <polyline className="cube-edge" points="100,50 100,175" pathLength={1} />
      <polygon className="cube-edge" points={silhouette} pathLength={1} />
      <polyline points="0,150 100,175 200,150" fill="none" stroke="var(--art-2)" strokeOpacity={0.5} strokeDasharray="1.2 2.2" strokeWidth={0.8} transform="translate(0 6)" />
    </svg>
  );
}

import { ChartFrame } from './ChartFrame';

export interface GraphEdge {
  from: string;
  to: string;
  weight: number;
}

/** Co-usage graph with a circular layout: edge width follows the weight. */
export function Graph({ title, desc, nodes, edges }: { title: string; desc?: string; nodes: string[]; edges: GraphEdge[] }) {
  const W = 640;
  const H = 420;
  const r = Math.min(W, H) / 2 - 90;
  const pos = new Map(nodes.map((n, i) => [n, { x: W / 2 + r * Math.cos((2 * Math.PI * i) / nodes.length - Math.PI / 2), y: H / 2 + r * Math.sin((2 * Math.PI * i) / nodes.length - Math.PI / 2) }]));
  const maxW = Math.max(1, ...edges.map((e) => e.weight));
  return (
    <ChartFrame title={title} desc={desc} table={{ columns: ['from', 'to', 'weight'], rows: edges.map((e) => [e.from, e.to, e.weight]) }} empty={!edges.length}>
      {({ titleId, descId }) => (
        <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${titleId} ${descId}`}>
          <title id={titleId}>{title}</title>
          {edges.map((e) => {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) return null;
            return (
              <line key={`${e.from}->${e.to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="graph-edge" strokeWidth={1 + (5 * e.weight) / maxW}>
                <title>{`${e.from} → ${e.to}: ${e.weight}`}</title>
              </line>
            );
          })}
          {nodes.map((n) => {
            const p = pos.get(n)!;
            const left = p.x < W / 2;
            return (
              <g key={n}>
                <circle cx={p.x} cy={p.y} r={6} className="graph-node" />
                <text x={p.x + (left ? -10 : 10)} y={p.y + 4} textAnchor={left ? 'end' : 'start'} className="chart-label">
                  {n}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </ChartFrame>
  );
}

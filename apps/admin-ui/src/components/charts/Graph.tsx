import { useMemo } from 'react';
import { useT } from '../../i18n';
import { ChartFrame, chartLabel } from './ChartFrame';
import { EChart } from './EChart';
import { graphOption } from './options/relations';
import { useBuildCtx } from './useBuildCtx';

export interface GraphEdge {
  from: string;
  to: string;
  weight: number;
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** Co-usage network: force layout, zoom and drag, hover highlights a node's neighbours. */
export function Graph({ title, desc, nodes, edges, weightLabel, maxNodes = 60 }: { title: string; desc?: string; nodes: string[]; edges: GraphEdge[]; weightLabel?: string; maxNodes?: number }) {
  const t = useT();
  const ctx = useBuildCtx();
  const wl = weightLabel ?? t('charts.weight');
  const option = useMemo(() => graphOption({ nodes, edges, maxNodes, reducedMotion: reducedMotion() }, { ...ctx, weightLabel: wl }), [nodes, edges, maxNodes, ctx, wl]);
  return (
    <ChartFrame title={title} table={{ columns: [t('charts.colFrom'), t('charts.colTo'), wl], rows: edges.map((e) => [e.from, e.to, e.weight]) }} empty={!edges.length}>
      <EChart option={option} height={460} label={chartLabel(title, desc)} />
    </ChartFrame>
  );
}

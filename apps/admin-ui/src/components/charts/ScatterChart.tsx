import { useMemo } from 'react';
import { useT } from '../../i18n';
import { ChartFrame, chartLabel } from './ChartFrame';
import { EChart } from './EChart';
import { scatterOption, type ScatterInput } from './options/relations';
import { useBuildCtx } from './useBuildCtx';

/** Bubble scatter; clicking a bubble selects its entity (click again to clear). */
export function ScatterChart({
  title,
  desc,
  points,
  xLabel,
  yLabel,
  sizeLabel,
  formatX = String,
  formatY = String,
  selected,
  onSelect,
}: {
  title: string;
  desc?: string;
  points: ScatterInput['points'];
  xLabel: string;
  yLabel: string;
  sizeLabel: string;
  formatX?: (v: number) => string;
  formatY?: (v: number) => string;
  selected?: string | null;
  onSelect?: (label: string | null) => void;
}) {
  const t = useT();
  const ctx = useBuildCtx();
  const option = useMemo(() => scatterOption({ points, xLabel, yLabel, sizeLabel, formatX, formatY, selected }, ctx), [points, xLabel, yLabel, sizeLabel, formatX, formatY, selected, ctx]);
  return (
    <ChartFrame title={title} table={{ columns: [t('charts.colLabel'), xLabel, yLabel, sizeLabel], rows: points.map((p) => [p.label, formatX(p.x), formatY(p.y), p.size]) }} empty={!points.length}>
      <EChart
        option={option}
        height={280}
        label={chartLabel(title, desc)}
        events={{
          click: (raw) => {
            const label = points[(raw as { dataIndex: number }).dataIndex]?.label ?? null;
            onSelect?.(label === selected ? null : label);
          },
        }}
      />
    </ChartFrame>
  );
}

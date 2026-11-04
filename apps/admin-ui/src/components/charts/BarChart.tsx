import { useMemo } from 'react';
import { useT } from '../../i18n';
import { ChartFrame, chartLabel } from './ChartFrame';
import { EChart } from './EChart';
import { BAR_ROW, barRows, barsOption, type Bar } from './options/bars';
import { useBuildCtx } from './useBuildCtx';

export type { Bar };

/** Horizontal ranking (tools, sources, detectors): sorted, value at the tip, tail folded in "Others". */
export function BarChart({
  title,
  desc,
  data,
  format = String,
  color = 0,
  max,
  sort,
  limit,
}: {
  title: string;
  desc?: string;
  data: Bar[];
  format?: (v: number) => string;
  color?: number;
  max?: number;
  sort?: boolean;
  limit?: number;
}) {
  const t = useT();
  const ctx = useBuildCtx();
  const option = useMemo(() => barsOption({ data, format, color, max, sort, limit }, ctx), [data, format, color, max, sort, limit, ctx]);
  const rows = barRows({ data, sort, limit }, ctx.othersLabel).length;
  return (
    <ChartFrame title={title} table={{ columns: [t('charts.colLabel'), t('charts.colValue')], rows: data.map((d) => [d.label, format(d.value)]) }} empty={!data.length}>
      <EChart option={option} height={Math.max(rows, 1) * BAR_ROW + 8} label={chartLabel(title, desc)} />
    </ChartFrame>
  );
}

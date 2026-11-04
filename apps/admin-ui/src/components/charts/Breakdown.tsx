import { useMemo } from 'react';
import { useT } from '../../i18n';
import { ChartFrame, chartLabel } from './ChartFrame';
import { EChart } from './EChart';
import { BAR_ROW, breakdownModel, breakdownOption, type BreakdownInput } from './options/bars';
import { useBuildCtx } from './useBuildCtx';

/** Stacked bars: one bar per category (e.g. tool), one segment per series (e.g. agent). */
export function Breakdown({
  title,
  desc,
  rows,
  categoryLabel,
  seriesLabel,
  format = String,
}: {
  title: string;
  desc?: string;
  rows: BreakdownInput['rows'];
  categoryLabel: string;
  seriesLabel: string;
  format?: (v: number) => string;
}) {
  const t = useT();
  const ctx = useBuildCtx();
  const totalLabel = t('charts.total');
  const option = useMemo(() => breakdownOption({ rows, format, totalLabel }, ctx), [rows, format, totalLabel, ctx]);
  const categories = breakdownModel({ rows, format, totalLabel }, ctx.othersLabel).categories.length;
  return (
    <ChartFrame title={title} table={{ columns: [categoryLabel, seriesLabel, t('charts.colValue')], rows: rows.map((r) => [r.category, r.series, format(r.value)]) }} empty={!rows.length}>
      <EChart option={option} height={Math.max(categories, 1) * BAR_ROW + 40} label={chartLabel(title, desc)} />
    </ChartFrame>
  );
}

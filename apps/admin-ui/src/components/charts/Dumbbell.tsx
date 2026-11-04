import { useMemo } from 'react';
import { useT } from '../../i18n';
import { ChartFrame, chartLabel } from './ChartFrame';
import { EChart } from './EChart';
import { BAR_ROW, dumbbellOption, type DumbbellInput } from './options/bars';
import { useBuildCtx } from './useBuildCtx';

/** Before → after per row (drift impact, usual × current volume). */
export function Dumbbell({
  title,
  desc,
  rows,
  beforeLabel,
  afterLabel,
  format = String,
}: {
  title: string;
  desc?: string;
  rows: DumbbellInput['rows'];
  beforeLabel: string;
  afterLabel: string;
  format?: (v: number) => string;
}) {
  const t = useT();
  const ctx = useBuildCtx();
  const option = useMemo(() => dumbbellOption({ rows, beforeLabel, afterLabel, format }, ctx), [rows, beforeLabel, afterLabel, format, ctx]);
  const f = (v: number | null) => (v == null ? null : format(v));
  return (
    <ChartFrame title={title} table={{ columns: [t('charts.colLabel'), beforeLabel, afterLabel], rows: rows.map((r) => [r.hint ? `${r.label} · ${r.hint}` : r.label, f(r.before), f(r.after)]) }} empty={!rows.length}>
      <EChart option={option} height={rows.length * BAR_ROW + 40} label={chartLabel(title, desc)} />
    </ChartFrame>
  );
}

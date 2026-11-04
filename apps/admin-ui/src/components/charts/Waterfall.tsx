import { useMemo, type ReactNode } from 'react';
import { useT } from '../../i18n';
import { ChartFrame, chartLabel } from './ChartFrame';
import { EChart } from './EChart';
import { BAR_ROW, waterfallOption } from './options/bars';
import { useBuildCtx } from './useBuildCtx';

/** Sequential stages of one call on a shared time axis. */
export function Waterfall({
  title,
  desc,
  stages,
  format = String,
  right,
}: {
  title: string;
  desc?: string;
  stages: Array<{ label: string; value: number }>;
  format?: (v: number) => string;
  right?: ReactNode;
}) {
  const t = useT();
  const ctx = useBuildCtx();
  const startLabel = t('charts.startsAt');
  const option = useMemo(() => waterfallOption({ stages, format, startLabel }, ctx), [stages, format, startLabel, ctx]);
  let at = 0;
  const rows = stages.map((s) => {
    const row = [s.label, format(at), format(s.value)];
    at += s.value;
    return row;
  });
  return (
    <ChartFrame title={title} table={{ columns: [t('charts.colLabel'), t('charts.startsAt'), t('charts.colValue')], rows }} empty={!stages.length} right={right}>
      <EChart option={option} height={stages.length * BAR_ROW + 32} label={chartLabel(title, desc)} />
    </ChartFrame>
  );
}

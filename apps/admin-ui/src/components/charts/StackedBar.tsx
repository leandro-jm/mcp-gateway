import { formatNumber } from '@mcp-gateway/i18n';
import { useMemo } from 'react';
import { getLocale, useT } from '../../i18n';
import { ChartFrame, chartLabel } from './ChartFrame';
import { EChart } from './EChart';
import { segmentsOption } from './options/bars';
import { useBuildCtx } from './useBuildCtx';

const share = (r: number) => formatNumber(getLocale(), r, { style: 'percent', maximumFractionDigits: 1 });

/** One bar split in parts (e.g. average time per stage); the legend toggles parts on and off. */
export function StackedBar({ title, desc, segments, format = String }: { title: string; desc?: string; segments: Array<{ label: string; value: number }>; format?: (v: number) => string }) {
  const t = useT();
  const ctx = useBuildCtx();
  const total = segments.reduce((a, s) => a + s.value, 0);
  const option = useMemo(() => segmentsOption({ segments, format, percentLabel: share }, ctx), [segments, format, ctx]);
  return (
    <ChartFrame
      title={title}
      table={{ columns: [t('charts.colLabel'), t('charts.colValue'), '%'], rows: segments.map((s) => [s.label, format(s.value), share(total ? s.value / total : 0)]) }}
      empty={!total}
    >
      <EChart option={option} height={segments.length > 4 ? 96 : 72} label={chartLabel(title, desc)} />
    </ChartFrame>
  );
}

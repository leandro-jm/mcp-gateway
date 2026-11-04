import { RotateCcw } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { ChartFrame, chartLabel } from './ChartFrame';
import { EChart } from './EChart';
import type { ECharts } from './echarts';
import { timeSeriesOption, ZOOM_THRESHOLD } from './options/time';
import { useBuildCtx } from './useBuildCtx';

export interface LineSeries {
  name: string;
  points: Array<{ x: string; y: number | null }>;
}

/**
 * Time series on one y axis: lines (or an area / columns for a single count). Crosshair tooltip
 * with every series; zoom slider when there are many buckets.
 */
export function LineChart({
  title,
  desc,
  series,
  formatY = String,
  formatX = (x: string) => x,
  mark = 'line',
  color,
  height = 240,
}: {
  title: string;
  desc?: string;
  series: LineSeries[];
  formatY?: (v: number) => string;
  formatX?: (x: string) => string;
  mark?: 'line' | 'area' | 'bar';
  color?: number;
  height?: number;
}) {
  const t = useT();
  const ctx = useBuildCtx();
  const chart = useRef<ECharts | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const xs = useMemo(() => [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort(), [series]);
  const option = useMemo(
    () =>
      timeSeriesOption(
        { xs, mark, formatX, formatY, color, series: series.map((s) => ({ name: s.name, values: xs.map((x) => s.points.find((p) => p.x === x)?.y ?? null) })) },
        ctx,
      ),
    [xs, series, mark, formatX, formatY, color, ctx],
  );
  const table = {
    columns: [t('charts.colTime'), ...series.map((s) => s.name)],
    rows: xs.map((x) => [formatX(x), ...series.map((s) => s.points.find((p) => p.x === x)?.y ?? null)]),
  };
  const zoomable = xs.length > ZOOM_THRESHOLD;
  const reset = zoomed ? (
    <button className="icon-btn" onClick={() => chart.current?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 })} aria-label={t('charts.resetZoom')} title={t('charts.resetZoom')}>
      <RotateCcw size={15} />
    </button>
  ) : null;
  return (
    <ChartFrame title={title} table={table} empty={!xs.length} right={reset}>
      <EChart
        option={option}
        height={height}
        label={chartLabel(title, zoomable ? `${desc ? `${desc}. ` : ''}${t('charts.zoomHint')}` : desc)}
        onReady={(c) => (chart.current = c)}
        events={{
          datazoom: (_, c) => {
            const dz = (c.getOption().dataZoom as Array<{ start?: number; end?: number }> | undefined)?.[0];
            setZoomed(!!dz && ((dz.start ?? 0) > 0 || (dz.end ?? 100) < 100));
          },
        }}
      />
    </ChartFrame>
  );
}

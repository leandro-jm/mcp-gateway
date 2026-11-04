import { baseOption, categorical, categoryAxis, legendOption, tipHead, tipRow, valueAxis, withAlpha, zoomOption, type BuildCtx, type EChartsOption, type Fmt } from './base';

export interface TimeSeriesInput {
  xs: string[];
  series: Array<{ name: string; values: Array<number | null> }>;
  mark: 'line' | 'area' | 'bar';
  formatX: (x: string) => string;
  formatY: Fmt;
  /** Single-series color (index into `--chart-N`); multi-series use the categorical order. */
  color?: number;
}

/** Above this many buckets the chart gets a zoom slider. */
export const ZOOM_THRESHOLD = 48;

interface AxisParam {
  axisValue: string;
  seriesName: string;
  value: number | null;
  color: string;
}

/** One measure over time on a single y axis (never two scales on one plot). */
export function timeSeriesOption(input: TimeSeriesInput, ctx: BuildCtx): EChartsOption {
  const { theme } = ctx;
  const multi = input.series.length > 1;
  const colors = multi ? categorical(theme) : [theme.series[input.color ?? 0]!];
  const zoom = input.xs.length > ZOOM_THRESHOLD;
  const bar = input.mark === 'bar';
  return {
    ...baseOption(ctx),
    color: colors,
    legend: multi ? legendOption(ctx) : undefined,
    grid: { left: 4, right: 12, top: multi ? 32 : 10, bottom: zoom ? 34 : 4, containLabel: true },
    xAxis: categoryAxis(ctx, input.xs, {
      boundaryGap: bar,
      axisLabel: { color: theme.text3, fontFamily: theme.mono, fontSize: 11, hideOverlap: true, formatter: (x: string) => input.formatX(x) },
    }),
    yAxis: valueAxis(ctx, input.formatY),
    dataZoom: zoomOption(ctx, zoom),
    tooltip: {
      ...baseOption(ctx).tooltip,
      trigger: 'axis',
      axisPointer: bar ? { type: 'shadow', shadowStyle: { color: withAlpha(theme.series[1]!, 0.06) } } : { type: 'line', lineStyle: { color: theme.borderStrong, width: 1 } },
      formatter: (raw: unknown) => {
        const params = raw as AxisParam[];
        if (!params.length) return '';
        const head = tipHead(input.formatX(params[0]!.axisValue));
        return head + params.map((p) => tipRow(theme, p.color, p.seriesName, p.value == null ? '—' : input.formatY(p.value))).join('');
      },
    },
    series: input.series.map((s) =>
      bar
        ? { type: 'bar' as const, name: s.name, data: s.values, barMaxWidth: 24, itemStyle: { borderRadius: [4, 4, 0, 0] }, emphasis: { itemStyle: { opacity: 0.85 } } }
        : {
            type: 'line' as const,
            name: s.name,
            data: s.values,
            showSymbol: input.xs.length <= 1,
            symbol: 'circle',
            symbolSize: 8,
            lineStyle: { width: 2, cap: 'round' as const, join: 'round' as const },
            itemStyle: { borderColor: theme.surface, borderWidth: 2 },
            areaStyle: input.mark === 'area' ? { opacity: 0.1 } : undefined,
            emphasis: { focus: 'series' as const, lineStyle: { width: 2 } },
            connectNulls: false,
          },
    ),
  };
}

export interface SparkInput {
  values: number[];
  labels?: string[];
  format?: Fmt;
}

/** Stat-tile trend: de-emphasized line, the current period marked; axis tooltip with the value. */
export function sparklineOption(input: SparkInput, ctx: BuildCtx): EChartsOption {
  const { theme } = ctx;
  const fmt = input.format ?? String;
  const last = input.values.length - 1;
  return {
    ...baseOption(ctx),
    animation: false,
    grid: { left: 4, right: 6, top: 6, bottom: 4 },
    xAxis: { type: 'category', show: false, boundaryGap: false, data: input.values.map((_, i) => input.labels?.[i] ?? String(i + 1)) },
    yAxis: { type: 'value', show: false, scale: true },
    tooltip: {
      ...baseOption(ctx).tooltip,
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: theme.borderStrong } },
      formatter: (raw: unknown) => {
        const p = (raw as AxisParam[])[0];
        if (!p) return '';
        return (input.labels ? tipHead(p.axisValue) : '') + tipRow(theme, null, '', fmt(Number(p.value)));
      },
    },
    series: [
      {
        type: 'line',
        data: input.values.map((v, i) => (i === last ? { value: v, symbol: 'circle', symbolSize: 7, itemStyle: { color: theme.text, borderColor: theme.surface, borderWidth: 2 } } : v)),
        showSymbol: true,
        symbol: 'none',
        lineStyle: { width: 1.5, color: theme.text3 },
        areaStyle: { color: theme.text3, opacity: 0.08 },
        emphasis: { disabled: true },
      },
    ],
  };
}

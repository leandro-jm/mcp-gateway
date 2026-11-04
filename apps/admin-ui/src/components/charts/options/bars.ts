import { baseOption, categorical, categoryAxis, foldTail, legendOption, tipHead, tipRow, truncate, valueAxis, withAlpha, type BuildCtx, type EChartsOption, type Fmt } from './base';

export interface Bar {
  label: string;
  value: number;
  hint?: string;
  /** Status meaning; overrides the series color (good/bad thresholds). */
  tone?: 'good' | 'bad';
}

export interface BarsInput {
  data: Bar[];
  format: Fmt;
  /** Index into `--chart-N`; one series, one color. */
  color?: number;
  /** Fixed axis maximum (e.g. 100 for percentages). */
  max?: number;
  /** Rank by value (default). Off when the order means something (before → after). */
  sort?: boolean;
  /** Rows beyond this fold into "Others". */
  limit?: number;
}

export const BAR_ROW = 30;

interface ItemParam {
  name: string;
  value: number | [number, number];
  color: string;
  seriesName: string;
  dataIndex: number;
  seriesIndex: number;
}

/** Rows a ranking will show after folding, so the component can size the chart. */
export function barRows(input: Pick<BarsInput, 'data' | 'sort' | 'limit'>, othersLabel = 'Others'): Bar[] {
  const rows = input.sort === false ? input.data : [...input.data].sort((a, b) => b.value - a.value);
  return input.sort === false ? rows : foldTail(rows, input.limit ?? 12, (value, count) => ({ label: `${othersLabel} (${count})`, value }));
}

/** Horizontal ranking: value at the bar tip, no value axis (every bar is labeled). */
export function barsOption(input: BarsInput, ctx: BuildCtx): EChartsOption {
  const { theme } = ctx;
  const rows = barRows(input, ctx.othersLabel);
  const base = theme.series[input.color ?? 0]!;
  const toneColor = (t?: Bar['tone']) => (t === 'good' ? theme.success : t === 'bad' ? theme.danger : base);
  return {
    ...baseOption(ctx),
    grid: { left: 4, right: 64, top: 2, bottom: 2, containLabel: true },
    xAxis: { type: 'value', show: false, max: input.max, min: 0 },
    yAxis: categoryAxis(ctx, rows.map((r) => r.label), {
      inverse: true,
      axisLine: { show: false },
      axisLabel: { color: theme.text, fontSize: 12, formatter: (l: string) => truncate(l, 30) },
    }),
    tooltip: {
      ...baseOption(ctx).tooltip,
      trigger: 'item',
      formatter: (raw: unknown) => {
        const p = raw as ItemParam;
        const row = rows[p.dataIndex]!;
        return tipHead(row.label) + tipRow(theme, toneColor(row.tone), row.hint ?? '', input.format(row.value));
      },
    },
    series: [
      {
        type: 'bar',
        data: rows.map((r) => ({ value: r.value, itemStyle: { color: toneColor(r.tone) } })),
        barWidth: 14,
        itemStyle: { borderRadius: [0, 4, 4, 0] },
        emphasis: { itemStyle: { opacity: 0.85 } },
        label: { show: true, position: 'right', color: theme.text2, fontFamily: theme.mono, fontSize: 11, formatter: (p: unknown) => input.format(rows[(p as ItemParam).dataIndex]!.value) },
      },
    ],
  };
}

export interface SegmentsInput {
  segments: Array<{ label: string; value: number }>;
  format: Fmt;
  percentLabel: (share: number) => string;
}

/** One bar split in parts (a whole and its shares); the legend names each part with its value. */
export function segmentsOption(input: SegmentsInput, ctx: BuildCtx): EChartsOption {
  const { theme } = ctx;
  const total = input.segments.reduce((a, s) => a + s.value, 0);
  const colors = categorical(theme);
  const last = input.segments.length - 1;
  const value = new Map(input.segments.map((s) => [s.label, s.value]));
  return {
    ...baseOption(ctx),
    color: colors,
    legend: legendOption(ctx, { top: undefined, bottom: 0, icon: 'roundRect', formatter: (name: string) => `${name}  ${input.format(value.get(name) ?? 0)}` }),
    grid: { left: 0, right: 0, top: 4, height: 22 },
    xAxis: { type: 'value', show: false, max: total || 1 },
    yAxis: { type: 'category', show: false, data: [''] },
    tooltip: {
      ...baseOption(ctx).tooltip,
      trigger: 'item',
      formatter: (raw: unknown) => {
        const p = raw as ItemParam;
        const v = Number(p.value);
        return tipRow(theme, p.color, p.seriesName, `${input.format(v)} · ${input.percentLabel(total ? v / total : 0)}`);
      },
    },
    series: input.segments.map((s, i) => ({
      type: 'bar' as const,
      name: s.label,
      stack: 'total',
      data: [s.value],
      barWidth: 22,
      itemStyle: { borderColor: theme.surface, borderWidth: 2, borderRadius: i === 0 && i === last ? 4 : i === 0 ? [4, 0, 0, 4] : i === last ? [0, 4, 4, 0] : 0 },
      emphasis: { itemStyle: { opacity: 0.85 } },
    })),
  };
}

export interface WaterfallInput {
  stages: Array<{ label: string; value: number }>;
  format: Fmt;
  startLabel: string;
}

/** Sequential stages on a shared time axis: each bar starts where the previous one ended. */
export function waterfallOption(input: WaterfallInput, ctx: BuildCtx): EChartsOption {
  const { theme } = ctx;
  const offsets: number[] = [];
  input.stages.reduce((acc, s) => (offsets.push(acc), acc + s.value), 0);
  const color = theme.series[1]!;
  return {
    ...baseOption(ctx),
    grid: { left: 4, right: 64, top: 4, bottom: 4, containLabel: true },
    xAxis: valueAxis(ctx, input.format),
    yAxis: categoryAxis(ctx, input.stages.map((s) => s.label), { inverse: true, axisLine: { show: false }, axisLabel: { color: theme.text, fontSize: 12 } }),
    tooltip: {
      ...baseOption(ctx).tooltip,
      trigger: 'item',
      formatter: (raw: unknown) => {
        const p = raw as ItemParam;
        const s = input.stages[p.dataIndex]!;
        return tipHead(s.label) + tipRow(theme, color, '', input.format(s.value)) + tipRow(theme, null, input.startLabel, input.format(offsets[p.dataIndex]!));
      },
    },
    series: [
      { type: 'bar', stack: 'w', silent: true, data: offsets, itemStyle: { color: 'transparent' }, tooltip: { show: false }, barWidth: 14 },
      {
        type: 'bar',
        stack: 'w',
        data: input.stages.map((s) => s.value),
        barWidth: 14,
        itemStyle: { color, borderRadius: 4 },
        emphasis: { itemStyle: { opacity: 0.85 } },
        label: { show: true, position: 'right', color: theme.text2, fontFamily: theme.mono, fontSize: 11, formatter: (p: unknown) => input.format(input.stages[(p as ItemParam).dataIndex]!.value) },
      },
    ],
  };
}

export interface BreakdownInput {
  /** Flat rows: category (bar) × series (segment) → value. */
  rows: Array<{ category: string; series: string; value: number }>;
  format: Fmt;
  totalLabel: string;
  maxSeries?: number;
  maxCategories?: number;
}

/** Collapses breakdown rows into ranked categories and at most `maxSeries` series (+ "Others"). */
export function breakdownModel(input: BreakdownInput, othersLabel = 'Others') {
  const sum = (key: 'category' | 'series') => {
    const m = new Map<string, number>();
    for (const r of input.rows) m.set(r[key], (m.get(r[key]) ?? 0) + r.value);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  };
  const categories = sum('category').slice(0, input.maxCategories ?? 15);
  const ranked = sum('series');
  const maxSeries = input.maxSeries ?? 5;
  const kept = ranked.length > maxSeries ? ranked.slice(0, maxSeries - 1) : ranked;
  const hasOthers = ranked.length > kept.length;
  const series = hasOthers ? [...kept, othersLabel] : kept;
  const values = series.map(() => categories.map(() => 0));
  for (const r of input.rows) {
    const ci = categories.indexOf(r.category);
    if (ci < 0) continue;
    const si = kept.includes(r.series) ? series.indexOf(r.series) : series.length - 1;
    values[si]![ci]! += r.value;
  }
  return { categories, series, values, hasOthers };
}

/** Stacked horizontal bars: one bar per category, one segment per series. */
export function breakdownOption(input: BreakdownInput, ctx: BuildCtx): EChartsOption {
  const { theme } = ctx;
  const m = breakdownModel(input, ctx.othersLabel);
  const palette = categorical(theme).slice(0, 4);
  const colors = m.series.map((_, i) => (m.hasOthers && i === m.series.length - 1 ? theme.series[5]! : palette[i % palette.length]!));
  const last = m.series.length - 1;
  return {
    ...baseOption(ctx),
    color: colors,
    legend: legendOption(ctx, { icon: 'roundRect' }),
    grid: { left: 4, right: 16, top: 32, bottom: 2, containLabel: true },
    xAxis: valueAxis(ctx, input.format),
    yAxis: categoryAxis(ctx, m.categories, { inverse: true, axisLine: { show: false }, axisLabel: { color: theme.text, fontSize: 12, formatter: (l: string) => truncate(l, 30) } }),
    tooltip: {
      ...baseOption(ctx).tooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: withAlpha(theme.series[1]!, 0.06) } },
      formatter: (raw: unknown) => {
        const params = (raw as ItemParam[]).filter((p) => Number(p.value) > 0);
        const ci = (raw as ItemParam[])[0]?.dataIndex ?? 0;
        const total = m.values.reduce((a, s) => a + (s[ci] ?? 0), 0);
        return tipHead(m.categories[ci] ?? '') + params.map((p) => tipRow(theme, p.color, p.seriesName, input.format(Number(p.value)))).join('') + tipRow(theme, null, input.totalLabel, input.format(total));
      },
    },
    series: m.series.map((name, si) => ({
      type: 'bar' as const,
      name,
      stack: 'total',
      data: m.values[si],
      barWidth: 14,
      itemStyle: { borderColor: theme.surface, borderWidth: 2, borderRadius: si === last ? [0, 4, 4, 0] : 0 },
      emphasis: { focus: 'series' as const },
    })),
  };
}

export interface DumbbellInput {
  rows: Array<{ label: string; before: number | null; after: number | null; hint?: string }>;
  beforeLabel: string;
  afterLabel: string;
  format: Fmt;
}

/** Before → after per row: two dots joined by a line; "after" is the colored mark. */
export function dumbbellOption(input: DumbbellInput, ctx: BuildCtx): EChartsOption {
  const { theme } = ctx;
  const before = theme.series[5]!;
  const after = theme.series[1]!;
  const dot = (color: string) => ({ color, borderColor: theme.surface, borderWidth: 2 });
  return {
    ...baseOption(ctx),
    color: [before, after],
    legend: legendOption(ctx, { icon: 'circle', itemWidth: 8, itemHeight: 8 }),
    grid: { left: 4, right: 20, top: 32, bottom: 2, containLabel: true },
    xAxis: valueAxis(ctx, input.format, { min: 0 }),
    yAxis: categoryAxis(ctx, input.rows.map((r) => r.label), { inverse: true, axisLine: { show: false }, axisLabel: { color: theme.text, fontSize: 12, formatter: (l: string) => truncate(l, 30) } }),
    tooltip: {
      ...baseOption(ctx).tooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: withAlpha(theme.series[1]!, 0.06) } },
      formatter: (raw: unknown) => {
        const i = (raw as ItemParam[])[0]?.dataIndex ?? 0;
        const r = input.rows[i]!;
        const f = (v: number | null) => (v == null ? '—' : input.format(v));
        return tipHead(r.hint ? `${r.label} · ${r.hint}` : r.label) + tipRow(theme, before, input.beforeLabel, f(r.before)) + tipRow(theme, after, input.afterLabel, f(r.after));
      },
    },
    series: [
      {
        type: 'scatter',
        name: input.beforeLabel,
        symbolSize: 10,
        itemStyle: dot(before),
        data: input.rows.map((r, i) => [r.before ?? '-', i]),
        z: 3,
      },
      {
        type: 'scatter',
        name: input.afterLabel,
        symbolSize: 10,
        itemStyle: dot(after),
        data: input.rows.map((r, i) => [r.after ?? '-', i]),
        z: 4,
        markLine: {
          silent: true,
          symbol: 'none',
          label: { show: false },
          lineStyle: { color: theme.borderStrong, width: 2, type: 'solid' },
          data: input.rows
            .map((r, i) => (r.before == null || r.after == null ? null : [{ coord: [r.before, i] }, { coord: [r.after, i] }]))
            .filter((d): d is [{ coord: [number, number] }, { coord: [number, number] }] => d !== null),
        },
      },
    ],
  };
}

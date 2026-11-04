import type { EChartsOption } from 'echarts';
import type { ChartTheme } from '../theme';

export type { EChartsOption };

/** Pure option builders (ADR-028): data + theme + formatters in, ECharts option out. No DOM. */
export interface BuildCtx {
  theme: ChartTheme;
  /** Fold label for the tail of a ranking ("Others"). */
  othersLabel?: string;
}

export type Fmt = (v: number) => string;

/**
 * Identity colors for multi-series charts, in fixed order: the four hued slots first, then the
 * two neutrals. Colors follow the entity's position in the input, never its rank.
 */
export function categorical(theme: ChartTheme): string[] {
  const [n1, c2, c3, c4, c5, n6] = theme.series;
  return [c2!, c3!, c4!, c5!, n1!, n6!];
}

/** Tooltip text is data (tool names, agents): always escaped before it reaches the HTML. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function truncate(s: string, max = 28): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Tooltip header line. */
export function tipHead(text: string): string {
  return `<div style="margin-bottom:4px;opacity:.75">${esc(text)}</div>`;
}

/** Tooltip row: a short line key in the series color, the value strong and the name secondary. */
export function tipRow(theme: ChartTheme, color: string | null, name: string, value: string): string {
  const key = color ? `<span style="display:inline-block;width:10px;height:2px;border-radius:1px;background:${color}"></span>` : '';
  return `<div style="display:flex;align-items:center;gap:8px;line-height:20px">${key}<b style="font-weight:600;color:${theme.text}">${esc(value)}</b><span style="color:${theme.text2}">${esc(name)}</span></div>`;
}

/** Shared look: fonts, tooltip card, animation. */
export function baseOption({ theme }: BuildCtx): EChartsOption {
  return {
    animationDuration: 300,
    animationDurationUpdate: 200,
    textStyle: { fontFamily: theme.font, color: theme.text2, fontSize: 12 },
    tooltip: {
      confine: true,
      backgroundColor: theme.surface,
      borderColor: theme.borderStrong,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: theme.text, fontFamily: theme.font, fontSize: 12 },
      extraCssText: 'border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.18);',
    },
  };
}

export function legendOption({ theme }: BuildCtx, extra: Record<string, unknown> = {}): EChartsOption['legend'] {
  return {
    top: 0,
    left: 0,
    itemWidth: 12,
    itemHeight: 8,
    itemGap: 16,
    textStyle: { color: theme.text2, fontSize: 12 },
    inactiveColor: theme.text3,
    ...extra,
  };
}

/** Recessive value axis: hairline solid grid, mono tick labels. */
export function valueAxis({ theme }: BuildCtx, format?: Fmt, extra: Record<string, unknown> = {}) {
  return {
    type: 'value' as const,
    splitLine: { lineStyle: { color: theme.grid, width: 1 } },
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: theme.text3, fontFamily: theme.mono, fontSize: 11, ...(format ? { formatter: (v: number) => format(v) } : {}) },
    ...extra,
  };
}

export function categoryAxis({ theme }: BuildCtx, data: string[], extra: Record<string, unknown> = {}) {
  return {
    type: 'category' as const,
    data,
    axisLine: { lineStyle: { color: theme.grid } },
    axisTick: { show: false },
    axisLabel: { color: theme.text2, fontSize: 11 },
    ...extra,
  };
}

/**
 * Zoom along x: a slider when there are many points, plus inside zoom that only reacts to
 * shift + wheel, so scrolling the page never zooms a chart by accident.
 */
export function zoomOption({ theme }: BuildCtx, slider: boolean): EChartsOption['dataZoom'] {
  const inside = { type: 'inside' as const, zoomOnMouseWheel: 'shift' as const, moveOnMouseWheel: false, moveOnMouseMove: true };
  if (!slider) return [inside];
  return [
    inside,
    {
      type: 'slider',
      height: 16,
      bottom: 4,
      showDetail: false,
      brushSelect: true,
      borderColor: theme.border,
      backgroundColor: 'transparent',
      fillerColor: withAlpha(theme.series[1]!, 0.12),
      dataBackground: { lineStyle: { color: theme.borderStrong }, areaStyle: { color: theme.surface2 } },
      selectedDataBackground: { lineStyle: { color: theme.series[1] }, areaStyle: { color: withAlpha(theme.series[1]!, 0.15) } },
      handleStyle: { color: theme.surface, borderColor: theme.borderStrong },
      moveHandleSize: 0,
      textStyle: { color: theme.text3 },
    },
  ];
}

/** `#rrggbb` + alpha → `rgba()`; other formats pass through. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) return color;
  return `rgba(${parseInt(m[1]!, 16)}, ${parseInt(m[2]!, 16)}, ${parseInt(m[3]!, 16)}, ${alpha})`;
}

/** Keeps the first `limit - 1` rows (by value, descending) and sums the rest into one row. */
export function foldTail<T extends { value: number }>(rows: T[], limit: number, make: (value: number, count: number) => T): T[] {
  if (rows.length <= limit) return rows;
  const head = rows.slice(0, limit - 1);
  const tail = rows.slice(limit - 1);
  return [...head, make(tail.reduce((a, r) => a + r.value, 0), tail.length)];
}

import { baseOption, categoryAxis, legendOption, tipHead, tipRow, valueAxis, zoomOption, type BuildCtx, type EChartsOption, type Fmt } from './base';

interface ItemParam {
  dataIndex: number;
  seriesIndex: number;
  dataType?: 'node' | 'edge';
  data: unknown;
  color: string;
}

export interface ScatterInput {
  points: Array<{ label: string; x: number; y: number; size: number }>;
  xLabel: string;
  yLabel: string;
  sizeLabel: string;
  formatX: Fmt;
  formatY: Fmt;
  selected?: string | null;
}

/** Bubble scatter: two measures of one entity; bubble area follows a third. */
export function scatterOption(input: ScatterInput, ctx: BuildCtx): EChartsOption {
  const { theme } = ctx;
  const maxSize = Math.max(1, ...input.points.map((p) => p.size));
  const color = theme.series[1]!;
  return {
    ...baseOption(ctx),
    grid: { left: 4, right: 20, top: 30, bottom: 22, containLabel: true },
    xAxis: valueAxis(ctx, input.formatX, { name: input.xLabel, nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: theme.text2, fontSize: 11 }, min: 0 }),
    yAxis: valueAxis(ctx, input.formatY, { name: input.yLabel, nameTextStyle: { color: theme.text2, fontSize: 11, align: 'left' }, min: 0 }),
    tooltip: {
      ...baseOption(ctx).tooltip,
      trigger: 'item',
      formatter: (raw: unknown) => {
        const p = input.points[(raw as ItemParam).dataIndex]!;
        return tipHead(p.label) + tipRow(theme, color, input.xLabel, input.formatX(p.x)) + tipRow(theme, null, input.yLabel, input.formatY(p.y)) + tipRow(theme, null, input.sizeLabel, String(p.size));
      },
    },
    series: [
      {
        type: 'scatter',
        cursor: 'pointer',
        data: input.points.map((p) => ({
          value: [p.x, p.y],
          symbolSize: 10 + 18 * Math.sqrt(p.size / maxSize),
          itemStyle: p.label === input.selected ? { color, opacity: 1, borderColor: theme.text, borderWidth: 2 } : { color, opacity: input.selected ? 0.35 : 0.8, borderColor: theme.surface, borderWidth: 2 },
        })),
        emphasis: { scale: 1.15, itemStyle: { opacity: 1 } },
      },
    ],
  };
}

export interface GraphInput {
  nodes: string[];
  edges: Array<{ from: string; to: string; weight: number }>;
  /** Keeps the most connected nodes (weighted degree). */
  maxNodes?: number;
  reducedMotion?: boolean;
}

/** Most connected nodes and the edges among them. */
export function graphModel(input: GraphInput) {
  const degree = new Map<string, number>(input.nodes.map((n) => [n, 0]));
  for (const e of input.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + e.weight);
    degree.set(e.to, (degree.get(e.to) ?? 0) + e.weight);
  }
  const nodes = [...degree.entries()].sort((a, b) => b[1] - a[1]).slice(0, input.maxNodes ?? 60);
  const kept = new Set(nodes.map(([n]) => n));
  const edges = input.edges.filter((e) => kept.has(e.from) && kept.has(e.to));
  return { nodes, edges };
}

/** Force-directed network: node size follows weighted degree, edge width follows the weight. */
export function graphOption(input: GraphInput, ctx: BuildCtx & { weightLabel: string }): EChartsOption {
  const { theme } = ctx;
  const m = graphModel(input);
  const maxDeg = Math.max(1, ...m.nodes.map(([, d]) => d));
  const maxW = Math.max(1, ...m.edges.map((e) => e.weight));
  return {
    ...baseOption(ctx),
    tooltip: {
      ...baseOption(ctx).tooltip,
      trigger: 'item',
      formatter: (raw: unknown) => {
        const p = raw as ItemParam;
        if (p.dataType === 'edge') {
          const e = m.edges[p.dataIndex]!;
          return tipHead(`${e.from} ↔ ${e.to}`) + tipRow(theme, null, ctx.weightLabel, String(e.weight));
        }
        const [name, deg] = m.nodes[p.dataIndex]!;
        return tipHead(name) + tipRow(theme, theme.series[1]!, ctx.weightLabel, String(deg));
      },
    },
    series: [
      {
        type: 'graph',
        layout: 'force',
        roam: true,
        draggable: true,
        force: { repulsion: 260, edgeLength: [50, 150], gravity: 0.08, layoutAnimation: !input.reducedMotion },
        label: { show: true, position: 'right', color: theme.text2, fontFamily: theme.mono, fontSize: 11 },
        labelLayout: { hideOverlap: true },
        emphasis: { focus: 'adjacency', label: { color: theme.text }, lineStyle: { opacity: 1 } },
        blur: { itemStyle: { opacity: 0.2 }, lineStyle: { opacity: 0.08 }, label: { opacity: 0.3 } },
        data: m.nodes.map(([name, deg]) => ({
          name,
          symbolSize: 10 + 18 * Math.sqrt(deg / maxDeg),
          itemStyle: { color: theme.series[1], borderColor: theme.surface, borderWidth: 2 },
        })),
        links: m.edges.map((e) => ({ source: e.from, target: e.to, lineStyle: { width: 1 + (5 * e.weight) / maxW } })),
        lineStyle: { color: theme.borderStrong, opacity: 0.7, curveness: 0.08 },
      },
    ],
  };
}

export interface SwimlaneInput {
  /** One point per step, in order. */
  points: Array<{ lane: string; group: string; tip: string; flagged?: boolean }>;
  groups: Array<{ id: string; label: string; tone: 'success' | 'warning' | 'danger' | 'muted' }>;
  current: number;
  stepLabel: string;
}

/** Steps (x) over lanes (y); color = group (decision) with a legend, ring = current step. */
export function swimlaneOption(input: SwimlaneInput, ctx: BuildCtx): EChartsOption {
  const { theme } = ctx;
  const lanes = [...new Set(input.points.map((p) => p.lane))];
  const tone = { success: theme.success, warning: theme.warning, danger: theme.danger, muted: theme.text3 };
  const known = new Set(input.groups.map((g) => g.id));
  const groups = input.points.some((p) => !known.has(p.group)) ? [...input.groups, { id: '*', label: '—', tone: 'muted' as const }] : input.groups;
  const cur = input.points[input.current];
  return {
    ...baseOption(ctx),
    color: groups.map((g) => tone[g.tone]),
    legend: legendOption(ctx, { icon: 'circle', itemWidth: 8, itemHeight: 8, data: groups.filter((g) => input.points.some((p) => p.group === g.id || (g.id === '*' && !known.has(p.group)))).map((g) => g.label) }),
    grid: { left: 4, right: 16, top: 32, bottom: input.points.length > 40 ? 34 : 4, containLabel: true },
    xAxis: valueAxis(ctx, (v) => String(v), { min: 1, max: Math.max(1, input.points.length), minInterval: 1, splitLine: { show: false }, axisLine: { show: true, lineStyle: { color: theme.grid } } }),
    yAxis: categoryAxis(ctx, lanes, { inverse: true, axisLine: { show: false }, splitLine: { show: true, lineStyle: { color: theme.grid } }, axisLabel: { color: theme.text, fontSize: 11, fontFamily: theme.mono, formatter: (l: string) => (l.length > 28 ? `${l.slice(0, 27)}…` : l) } }),
    dataZoom: zoomOption(ctx, input.points.length > 40),
    tooltip: {
      ...baseOption(ctx).tooltip,
      trigger: 'item',
      formatter: (raw: unknown) => {
        const i = ((raw as ItemParam).data as { value: [number, number, number] }).value[2];
        const p = input.points[i]!;
        return tipHead(`${input.stepLabel} ${i + 1}`) + tipRow(theme, (raw as ItemParam).color, p.lane, p.tip);
      },
    },
    series: [
      ...groups.map((g) => ({
        type: 'scatter' as const,
        name: g.label,
        cursor: 'pointer',
        z: 3,
        itemStyle: { color: tone[g.tone], borderColor: theme.surface, borderWidth: 2 },
        emphasis: { scale: 1.3 },
        data: input.points.flatMap((p, i) =>
          p.group === g.id || (g.id === '*' && !known.has(p.group)) ? [{ value: [i + 1, lanes.indexOf(p.lane), i], symbolSize: p.flagged ? 14 : 10, symbol: p.flagged ? 'diamond' : 'circle' }] : [],
        ),
      })),
      {
        type: 'scatter' as const,
        silent: true,
        z: 2,
        symbolSize: 22,
        itemStyle: { color: 'transparent', borderColor: theme.accent, borderWidth: 2 },
        data: cur ? [[input.current + 1, lanes.indexOf(cur.lane)]] : [],
        tooltip: { show: false },
      },
    ],
  };
}

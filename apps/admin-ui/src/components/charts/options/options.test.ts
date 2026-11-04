import { describe, expect, it } from 'vitest';
import { DEFAULT_CHART_THEME } from '../theme';
import { categorical, esc, foldTail } from './base';
import { barRows, barsOption, breakdownModel, dumbbellOption, waterfallOption } from './bars';
import { graphModel, swimlaneOption } from './relations';
import { timeSeriesOption, ZOOM_THRESHOLD } from './time';

const ctx = { theme: DEFAULT_CHART_THEME, othersLabel: 'Others' };
const fmt = (v: number) => `${v}`;

type Series = Array<Record<string, unknown>>;
type Formatter = (p: unknown) => string;

describe('chart option builders', () => {
  it('escapes data before it reaches tooltip HTML', () => {
    expect(esc(`<img src=x onerror="a('b')">&`)).toBe('&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
    const opt = barsOption({ data: [{ label: '<script>x</script>', value: 3 }], format: fmt }, ctx);
    const html = ((opt.tooltip as { formatter: Formatter }).formatter)({ dataIndex: 0 });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('puts the hued slots first in the categorical order (neutrals last)', () => {
    const [n1, c2, c3, c4, c5, n6] = DEFAULT_CHART_THEME.series;
    expect(categorical(DEFAULT_CHART_THEME)).toEqual([c2, c3, c4, c5, n1, n6]);
  });

  it('ranks bars and folds the tail into one "Others" row', () => {
    const data = Array.from({ length: 15 }, (_, i) => ({ label: `t${i}`, value: i }));
    const rows = barRows({ data, limit: 5 }, 'Others');
    expect(rows.map((r) => r.label)).toEqual(['t14', 't13', 't12', 't11', 'Others (11)']);
    expect(rows[4]!.value).toBe(55);
    expect(barRows({ data: data.slice(0, 3), sort: false }).map((r) => r.label)).toEqual(['t0', 't1', 't2']);
    expect(foldTail([{ value: 1 }], 3, (value) => ({ value }))).toEqual([{ value: 1 }]);
  });

  it('keeps one y axis and adds the zoom slider only for long series', () => {
    const xs = (n: number) => Array.from({ length: n }, (_, i) => `2026-11-0${i}`);
    const build = (n: number) =>
      timeSeriesOption({ xs: xs(n), mark: 'line', formatX: String, formatY: fmt, series: [{ name: 'a', values: xs(n).map(() => 1) }, { name: 'b', values: xs(n).map(() => 2) }] }, ctx);
    const short = build(10);
    expect(Array.isArray(short.yAxis)).toBe(false);
    expect(short.dataZoom).toHaveLength(1);
    expect(build(ZOOM_THRESHOLD + 1).dataZoom).toHaveLength(2);
    expect(short.legend).toBeDefined();
  });

  it('folds breakdown series beyond the limit into "Others" and keeps totals', () => {
    const rows = ['a', 'b', 'c', 'd'].flatMap((agent, i) => [
      { category: 'search', series: agent, value: 10 - i },
      { category: 'get', series: agent, value: 1 },
    ]);
    const m = breakdownModel({ rows, format: fmt, totalLabel: 'Total', maxSeries: 3 }, 'Others');
    expect(m.categories).toEqual(['search', 'get']);
    expect(m.series).toEqual(['a', 'b', 'Others']);
    expect(m.values[2]).toEqual([8 + 7, 2]);
    const sum = m.values.reduce((a, s) => a + s[0]!, 0);
    expect(sum).toBe(10 + 9 + 8 + 7);
  });

  it('starts each waterfall stage where the previous one ended', () => {
    const opt = waterfallOption({ stages: [{ label: 'authz', value: 2 }, { label: 'upstream', value: 30 }, { label: 'projection', value: 3 }], format: fmt, startLabel: 'at' }, ctx);
    const series = opt.series as Series;
    expect(series[0]!.data).toEqual([0, 2, 32]);
    expect(series[1]!.data).toEqual([2, 30, 3]);
  });

  it('marks missing dumbbell values as empty and joins only complete rows', () => {
    const opt = dumbbellOption({ rows: [{ label: 'a', before: 0.1, after: 0.4 }, { label: 'b', before: null, after: 0.2 }], beforeLabel: 'before', afterLabel: 'after', format: fmt }, ctx);
    const series = opt.series as Series;
    expect(series[0]!.data).toEqual([[0.1, 0], ['-', 1]]);
    expect((series[1]!.markLine as { data: unknown[] }).data).toHaveLength(1);
  });

  it('keeps the most connected graph nodes and drops edges to removed ones', () => {
    const m = graphModel({
      nodes: ['a', 'b', 'c', 'd'],
      edges: [
        { from: 'a', to: 'b', weight: 10 },
        { from: 'b', to: 'c', weight: 5 },
        { from: 'c', to: 'd', weight: 1 },
      ],
      maxNodes: 3,
    });
    expect(m.nodes.map(([n]) => n)).toEqual(['b', 'a', 'c']);
    expect(m.edges.map((e) => `${e.from}-${e.to}`)).toEqual(['a-b', 'b-c']);
  });

  it('colors swimlane points by group and rings the current step', () => {
    const opt = swimlaneOption(
      {
        points: [
          { lane: 'search', group: 'allow', tip: '' },
          { lane: 'get', group: 'deny', tip: '' },
          { lane: 'search', group: 'weird', tip: '' },
        ],
        groups: [
          { id: 'allow', label: 'Allowed', tone: 'success' },
          { id: 'deny', label: 'Denied', tone: 'warning' },
        ],
        current: 1,
        stepLabel: 'Step',
      },
      ctx,
    );
    const series = opt.series as Series;
    expect(series.map((s) => s.name)).toEqual(['Allowed', 'Denied', '—', undefined]);
    expect((series[2]!.data as Array<{ value: number[] }>)[0]!.value).toEqual([3, 0, 2]);
    expect(series[3]!.data).toEqual([[2, 1]]);
  });
});

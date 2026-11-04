import { useEffect, useRef } from 'react';
import { echarts, type ECharts } from './echarts';
import type { EChartsOption } from './options/base';

export type ChartEvents = Partial<Record<'click' | 'datazoom', (params: unknown, chart: ECharts) => void>>;

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** Option identity ignoring formatter closures: skips redundant updates (and replayed animations). */
const fingerprint = (o: EChartsOption) => JSON.stringify(o);

/**
 * ECharts mounted in a div (SVG renderer, ADR-028). Sizes with its container, disposes on
 * unmount; `merge` keeps interaction state (zoom) across updates, e.g. a replay cursor.
 */
export function EChart({ option, height, label, events, merge, onReady }: { option: EChartsOption; height: number; label: string; events?: ChartEvents; merge?: boolean; onReady?: (chart: ECharts) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const last = useRef('');
  const handlers = useRef(events);
  const ready = useRef(onReady);

  useEffect(() => {
    handlers.current = events;
    ready.current = onReady;
  });

  useEffect(() => {
    const node = el.current!;
    const c = echarts.init(node, null, { renderer: 'svg' });
    chart.current = c;
    for (const name of ['click', 'datazoom'] as const) c.on(name, (...args: unknown[]) => handlers.current?.[name]?.(args[0], c));
    ready.current?.(c);
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(node);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
      last.current = '';
    };
  }, []);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const fp = fingerprint(option);
    if (fp === last.current) return;
    last.current = fp;
    const opt = prefersReducedMotion() ? { ...option, animation: false } : option;
    c.setOption(opt, merge ? { replaceMerge: ['series'] } : { notMerge: true });
  }, [option, merge]);

  return <div ref={el} className="chart-canvas" style={{ height }} role="img" aria-label={label} />;
}

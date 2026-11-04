import { useEffect, useState } from 'react';

/** Theme tokens resolved to concrete colors: ECharts paints with values, not `var(--…)`. */
export interface ChartTheme {
  /** `--chart-1..6`; 1 and 6 are neutral (ADR-026), 2..5 carry identity. */
  series: string[];
  grid: string;
  text: string;
  text2: string;
  text3: string;
  surface: string;
  surface2: string;
  border: string;
  borderStrong: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
  font: string;
  mono: string;
}

/** Dark theme values; used outside the browser (tests) and as fallback for a missing token. */
export const DEFAULT_CHART_THEME: ChartTheme = {
  series: ['#e4e4e7', '#3b82f6', '#16a34a', '#8b5cf6', '#d97706', '#71717a'],
  grid: '#26262b',
  text: '#f4f4f5',
  text2: '#a1a1aa',
  text3: '#71717a',
  surface: '#141416',
  surface2: '#1b1b1e',
  border: '#26262b',
  borderStrong: '#36363d',
  accent: '#fafafa',
  success: '#5ccb8c',
  warning: '#e8a94d',
  danger: '#f38a81',
  font: 'system-ui, sans-serif',
  mono: 'ui-monospace, monospace',
};

/** Reads the chart tokens from the document root (the active light/dark block). */
export function readChartTheme(root: HTMLElement = document.documentElement): ChartTheme {
  const css = getComputedStyle(root);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const d = DEFAULT_CHART_THEME;
  return {
    series: d.series.map((c, i) => v(`--chart-${i + 1}`, c)),
    grid: v('--chart-grid', d.grid),
    text: v('--text', d.text),
    text2: v('--text-2', d.text2),
    text3: v('--text-3', d.text3),
    surface: v('--surface', d.surface),
    surface2: v('--surface-2', d.surface2),
    border: v('--border', d.border),
    borderStrong: v('--border-strong', d.borderStrong),
    accent: v('--accent', d.accent),
    success: v('--success', d.success),
    warning: v('--warning', d.warning),
    danger: v('--danger', d.danger),
    font: v('--font-sans', d.font),
    mono: v('--font-mono', d.mono),
  };
}

/**
 * Chart theme that follows the app theme. It watches `data-theme` and the OS color scheme
 * directly, so it reads the tokens after the attribute changed, whatever the render order.
 */
export function useChartTheme(): ChartTheme {
  const [theme, setTheme] = useState(readChartTheme);
  useEffect(() => {
    const update = () => setTheme(readChartTheme());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia?.('(prefers-color-scheme: light)');
    mq?.addEventListener('change', update);
    return () => {
      observer.disconnect();
      mq?.removeEventListener('change', update);
    };
  }, []);
  return theme;
}

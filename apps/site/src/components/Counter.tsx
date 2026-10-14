import { formatNumber } from '@mcp-gateway/i18n';
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { useInView, useReducedMotion } from '../lib/motion';

/** Number that counts up (ease-out) the first time it scrolls into view, formatted for the active locale. */
export function Counter({ value, decimals = 0, duration = 1400 }: { value: number; decimals?: number; duration?: number }) {
  const { locale } = useI18n();
  const reduce = useReducedMotion();
  const [ref, seen] = useInView<HTMLSpanElement>(0.4);
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    if (!seen) return;
    if (reduce) {
      setCurrent(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      setCurrent(value * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [seen, reduce, value, duration]);

  const fmt = (n: number) => formatNumber(locale, n, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return (
    <span ref={ref} className="counter">
      <span className="sr-only">{fmt(value)}</span>
      <span aria-hidden="true">{fmt(current)}</span>
    </span>
  );
}

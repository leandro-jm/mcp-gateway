import { formatNumber } from '@mcp-gateway/i18n';
import type { SiteMessageKey } from '../i18n/catalog';
import { useI18n } from '../i18n/I18nProvider';
import { useInView } from '../lib/motion';

interface Metric {
  label: SiteMessageKey;
  direct: number;
  omni: number;
  decimals: number;
}

/** docs/perf/agent-bench-2026-11-04.md, Claude Haiku 5.5, 80 tasks per scenario. */
const METRICS: Metric[] = [
  { label: 'perf.benchTokens', direct: 108_351, omni: 1_512, decimals: 0 },
  { label: 'perf.benchCost', direct: 17.93, omni: 1.39, decimals: 2 },
  { label: 'perf.benchSuccess', direct: 99, omni: 91, decimals: 0 },
];

/**
 * Three small bar charts, one per measure, because the measures have different units. Each compares
 * the same two series (direct, Omni), named on every bar, so color never carries the meaning alone.
 */
export function BenchBars() {
  const { locale, t } = useI18n();
  const [ref, seen] = useInView<HTMLDivElement>(0.3);
  return (
    <div className={`bench-charts ${seen ? 'is-visible' : ''}`} ref={ref}>
      {METRICS.map((m) => {
        const max = Math.max(m.direct, m.omni);
        const fmt = (n: number) => formatNumber(locale, n, { minimumFractionDigits: m.decimals, maximumFractionDigits: m.decimals });
        return (
          <figure key={m.label} className="bench-chart">
            <figcaption>{t(m.label)}</figcaption>
            {(['direct', 'omni'] as const).map((series) => (
              <div key={series} className="bench-row" title={`${t(series === 'direct' ? 'perf.benchDirect' : 'perf.benchOmni')}: ${fmt(m[series])}`}>
                <span className="bench-name">{t(series === 'direct' ? 'perf.benchDirect' : 'perf.benchOmni')}</span>
                <span className="bench-track">
                  <i className={`bench-bar bench-${series}`} style={{ width: `${Math.max(1, (m[series] / max) * 100)}%` }} />
                </span>
                <span className="bench-value">{fmt(m[series])}</span>
              </div>
            ))}
          </figure>
        );
      })}
    </div>
  );
}

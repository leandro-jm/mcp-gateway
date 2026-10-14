import { ArrowUpRight } from 'lucide-react';
import { Counter } from '../components/Counter';
import { Reveal } from '../components/Reveal';
import { useT } from '../i18n/I18nProvider';
import { repoTree } from '../lib/links';
import { SectionHead } from './SectionHead';

/** Numbers from docs/perf/README.md (F15 re-measurement, 2026-10-04). */
export function Performance() {
  const t = useT();
  return (
    <section className="section" id="performance">
      <div className="container">
        <SectionHead index="05" label={t('perf.label')} title={t('perf.title')} lead={t('perf.lead')} />
        <div className="stats">
          <Reveal className="stat stat-hero">
            <div className="stat-value">
              <Counter value={4.55} decimals={2} />
              <small>{t('perf.ms')}</small>
            </div>
            <div className="stat-label">{t('perf.p95')}</div>
            <div className="stat-bar" aria-hidden="true">
              <span style={{ width: '15%' }} />
              <em>{t('perf.target')} 30 ms</em>
            </div>
          </Reveal>
          <Reveal className="stat" delay={80}>
            <div className="stat-value">
              <Counter value={1.33} decimals={2} />
              <small>{t('perf.ms')}</small>
            </div>
            <div className="stat-label">{t('perf.avg')}</div>
          </Reveal>
          <Reveal className="stat" delay={160}>
            <div className="stat-value">
              <Counter value={200} />
            </div>
            <div className="stat-label">{t('perf.rps')}</div>
          </Reveal>
          <Reveal className="stat" delay={240}>
            <div className="stat-value">
              <Counter value={0} />
              <small>%</small>
            </div>
            <div className="stat-label">{t('perf.errors')}</div>
          </Reveal>
        </div>
        <Reveal className="perf-note">
          <p>{t('perf.note')}</p>
          <a href={repoTree('docs/perf')} target="_blank" rel="noreferrer">
            {t('perf.report')}
            <ArrowUpRight size={15} />
          </a>
        </Reveal>
      </div>
    </section>
  );
}

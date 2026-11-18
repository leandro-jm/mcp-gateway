import { GitCompareArrows, PenLine, Workflow, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Reveal } from '../components/Reveal';
import type { SiteMessageKey } from '../i18n/catalog';
import { useT } from '../i18n/I18nProvider';
import { trackPointer } from '../lib/motion';
import { SectionHead } from './SectionHead';

const FORMATS = ['OpenAPI 3.x', 'Swagger 2.0', 'Postman', 'HAR', 'cURL'];

const STEPS: Array<{ title: SiteMessageKey; body: SiteMessageKey; extra: ReactNode }> = [
  {
    title: 'sources.importTitle',
    body: 'sources.importBody',
    extra: FORMATS.map((f) => (
      <span key={f} className="tag">
        {f}
      </span>
    )),
  },
  { title: 'sources.generateTitle', body: 'sources.generateBody', extra: <span className="pill pill-off">disabled</span> },
  { title: 'sources.reviewTitle', body: 'sources.reviewBody', extra: <span className="pill pill-allow">enabled</span> },
  { title: 'sources.publishTitle', body: 'sources.publishBody', extra: <code className="tag">/mcp/s/:slug</code> },
];

const EXTRAS: Array<{ title: SiteMessageKey; body: SiteMessageKey; icon: LucideIcon }> = [
  { title: 'sources.driftTitle', body: 'sources.driftBody', icon: GitCompareArrows },
  { title: 'sources.compositeTitle', body: 'sources.compositeBody', icon: Workflow },
  { title: 'sources.manualTitle', body: 'sources.manualBody', icon: PenLine },
];

export function Sources() {
  const t = useT();
  return (
    <section className="section" id="sources">
      <div className="container">
        <SectionHead index="06" label={t('sources.label')} title={t('sources.title')} lead={t('sources.lead')} />
        <Reveal>
          <ol className="flow">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flow-step">
                <span className="flow-num">{i + 1}</span>
                <h3>{t(s.title)}</h3>
                <p>{t(s.body)}</p>
                <div className="flow-extra">{s.extra}</div>
              </li>
            ))}
          </ol>
        </Reveal>
        <div className="points">
          {EXTRAS.map((p, i) => {
            const Icon = p.icon;
            return (
              <Reveal key={p.title} delay={i * 70}>
                <article className="mini spotlight" onPointerMove={trackPointer}>
                  <Icon size={18} className="mini-icon" />
                  <h4>{t(p.title)}</h4>
                  <p>{t(p.body)}</p>
                </article>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

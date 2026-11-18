import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { AccessViz, CostViz, DataViz, EventFeed } from '../components/PillarVisuals';
import { Reveal } from '../components/Reveal';
import type { SiteMessageKey } from '../i18n/catalog';
import { useT } from '../i18n/I18nProvider';
import { trackPointer } from '../lib/motion';
import { SectionHead } from './SectionHead';

type Id = 'access' | 'data' | 'cost' | 'see';
const PILLARS: Array<{ id: Id; viz: ReactNode }> = [
  { id: 'access', viz: <AccessViz /> },
  { id: 'data', viz: <DataViz /> },
  { id: 'cost', viz: <CostViz /> },
  { id: 'see', viz: <EventFeed /> },
];

const key = (id: Id, suffix: string) => `pillars.${id}${suffix}` as SiteMessageKey;

export function Pillars() {
  const t = useT();
  return (
    <section className="section section-alt" id="govern">
      <div className="container">
        <SectionHead index="02" label={t('pillars.label')} title={t('pillars.title')} lead={t('pillars.lead')} />
        <div className="pillars">
          {PILLARS.map((p, i) => (
            <Reveal key={p.id} delay={(i % 2) * 90}>
              <article className="pillar spotlight beam" onPointerMove={trackPointer}>
                {p.viz}
                <div className="pillar-copy">
                  <span className="pillar-q">{t(key(p.id, 'Q'))}</span>
                  <h3>{t(key(p.id, 'Title'))}</h3>
                  <p>{t(key(p.id, 'Body'))}</p>
                  <ul className="checklist">
                    {['B1', 'B2', 'B3'].map((b) => (
                      <li key={b}>
                        <Check size={16} />
                        {t(key(p.id, b))}
                      </li>
                    ))}
                  </ul>
                </div>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

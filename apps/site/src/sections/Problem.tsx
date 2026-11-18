import { EyeOff, FileQuestion, KeyRound, Scale, type LucideIcon } from 'lucide-react';
import { Reveal } from '../components/Reveal';
import { SprawlArt } from '../components/SprawlArt';
import type { SiteMessageKey } from '../i18n/catalog';
import { useT } from '../i18n/I18nProvider';
import { SectionHead } from './SectionHead';

const PAINS: Array<{ title: SiteMessageKey; body: SiteMessageKey; icon: LucideIcon }> = [
  { title: 'problem.credsTitle', body: 'problem.credsBody', icon: KeyRound },
  { title: 'problem.rulesTitle', body: 'problem.rulesBody', icon: Scale },
  { title: 'problem.dataTitle', body: 'problem.dataBody', icon: EyeOff },
  { title: 'problem.trailTitle', body: 'problem.trailBody', icon: FileQuestion },
];

export function Problem() {
  const t = useT();
  return (
    <section className="section" id="problem">
      <div className="container">
        <SectionHead index="01" label={t('problem.label')} title={t('problem.title')} lead={t('problem.lead')} />
        <div className="problem-grid">
          <ul className="pains">
            {PAINS.map((p, i) => {
              const Icon = p.icon;
              return (
                <li key={p.title}>
                  <Reveal delay={i * 70} className="pain">
                    <Icon size={18} className="pain-icon" />
                    <div>
                      <h3>{t(p.title)}</h3>
                      <p>{t(p.body)}</p>
                    </div>
                  </Reveal>
                </li>
              );
            })}
          </ul>
          <Reveal delay={120}>
            <SprawlArt />
          </Reveal>
        </div>
      </div>
    </section>
  );
}

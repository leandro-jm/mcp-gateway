import { ClipboardList, EyeOff, KeyRound, Minimize2, PlugZap, ShieldOff, type LucideIcon } from 'lucide-react';
import { Reveal } from '../components/Reveal';
import type { SiteMessageKey } from '../i18n/catalog';
import { useT } from '../i18n/I18nProvider';
import { trackPointer } from '../lib/motion';
import { SectionHead } from './SectionHead';

const PRINCIPLES: Array<{ title: SiteMessageKey; body: SiteMessageKey; icon: LucideIcon }> = [
  { title: 'why.denyTitle', body: 'why.denyBody', icon: ShieldOff },
  { title: 'why.downstreamTitle', body: 'why.downstreamBody', icon: PlugZap },
  { title: 'why.credsTitle', body: 'why.credsBody', icon: KeyRound },
  { title: 'why.piiTitle', body: 'why.piiBody', icon: EyeOff },
  { title: 'why.contextTitle', body: 'why.contextBody', icon: Minimize2 },
  { title: 'why.auditTitle', body: 'why.auditBody', icon: ClipboardList },
];

export function Why() {
  const t = useT();
  return (
    <section className="section" id="why">
      <div className="container">
        <SectionHead index="01" label={t('why.label')} title={t('why.title')} lead={t('why.lead')} />
        <div className="cards">
          {PRINCIPLES.map((p, i) => {
            const Icon = p.icon;
            return (
              <Reveal key={p.title} delay={i * 70}>
                <article className="card spotlight" onPointerMove={trackPointer}>
                  <span className="card-index mono-label">{String(i + 1).padStart(2, '0')}</span>
                  <Icon className="card-icon" size={22} />
                  <h3>{t(p.title)}</h3>
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

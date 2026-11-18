import { Feather, LayoutDashboard, Palette, UserCheck, type LucideIcon } from 'lucide-react';
import { GenUiDemo } from '../components/GenUiDemo';
import { Reveal } from '../components/Reveal';
import type { SiteMessageKey } from '../i18n/catalog';
import { useT } from '../i18n/I18nProvider';
import { trackPointer } from '../lib/motion';
import { SectionHead } from './SectionHead';

const POINTS: Array<{ title: SiteMessageKey; body: SiteMessageKey; icon: LucideIcon }> = [
  { title: 'genui.viewsTitle', body: 'genui.viewsBody', icon: LayoutDashboard },
  { title: 'genui.humanTitle', body: 'genui.humanBody', icon: UserCheck },
  { title: 'genui.themeTitle', body: 'genui.themeBody', icon: Palette },
  { title: 'genui.contextTitle', body: 'genui.contextBody', icon: Feather },
];

/** Spotlight section: generative UI through MCP Apps (ADR-022), with the interactive demo as the centerpiece. */
export function GenerativeUi() {
  const t = useT();
  return (
    <section className="section genui-sec" id="genui">
      <div className="container">
        <SectionHead index="04" label={t('genui.label')} title={t('genui.title')} lead={t('genui.lead')} />
        <Reveal className="genui-hosts">
          <span className="genui-badge">MCP Apps</span>
          {t('genui.hosts')}
        </Reveal>
        <Reveal delay={100}>
          <GenUiDemo />
        </Reveal>
        <div className="more-grid genui-points">
          {POINTS.map((p, i) => {
            const Icon = p.icon;
            return (
              <Reveal key={p.title} delay={i * 60}>
                <article className="mini spotlight" onPointerMove={trackPointer}>
                  <Icon size={18} className="mini-icon" />
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

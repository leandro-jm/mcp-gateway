import { Boxes, Building2, Check, FileStack, Filter, Languages, Rocket, Search, ShieldCheck, Vault, type LucideIcon } from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Reveal } from '../components/Reveal';
import type { SiteMessageKey } from '../i18n/catalog';
import { useT } from '../i18n/I18nProvider';
import { asset } from '../lib/links';
import { trackPointer, useReducedMotion } from '../lib/motion';
import { useTheme } from '../theme/theme';
import { SectionHead } from './SectionHead';

type TabId = 'tools' | 'policies' | 'pii' | 'composer' | 'observability' | 'playground';

/** `screen` matches the files written by scripts/capture-screens.ts (`<screen>-<theme>.jpg`). */
const TABS: Array<{ id: TabId; screen: string; path: string }> = [
  { id: 'tools', screen: 'tools', path: '/tools' },
  { id: 'policies', screen: 'policies', path: '/policies' },
  { id: 'pii', screen: 'pii', path: '/pii' },
  { id: 'composer', screen: 'composer', path: '/composer' },
  { id: 'observability', screen: 'observability', path: '/observability' },
  { id: 'playground', screen: 'playground', path: '/playground' },
];

const key = <S extends string>(id: TabId, suffix: S) => `features.${id}${suffix}` as SiteMessageKey;

const MORE: Array<{ title: SiteMessageKey; body: SiteMessageKey; icon: LucideIcon }> = [
  { title: 'features.vaultTitle', body: 'features.vaultBody', icon: Vault },
  { title: 'features.tenantTitle', body: 'features.tenantBody', icon: Building2 },
  { title: 'features.omniTitle', body: 'features.omniBody', icon: Search },
  { title: 'features.artifactsTitle', body: 'features.artifactsBody', icon: FileStack },
  { title: 'features.projectionTitle', body: 'features.projectionBody', icon: Filter },
  { title: 'features.securityTitle', body: 'features.securityBody', icon: ShieldCheck },
  { title: 'features.i18nTitle', body: 'features.i18nBody', icon: Languages },
  { title: 'features.deployTitle', body: 'features.deployBody', icon: Rocket },
];

function Screenshot({ tab }: { tab: (typeof TABS)[number] }) {
  const t = useT();
  const { resolved } = useTheme();
  const reduce = useReducedMotion();
  const frame = useRef<HTMLDivElement>(null);

  // Subtle 3D tilt that follows the pointer.
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (reduce || e.pointerType !== 'mouse' || !frame.current) return;
    const r = frame.current.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    frame.current.style.setProperty('--rx', `${(-y * 4).toFixed(2)}deg`);
    frame.current.style.setProperty('--ry', `${(x * 5).toFixed(2)}deg`);
  };
  const onLeave = () => {
    frame.current?.style.setProperty('--rx', '0deg');
    frame.current?.style.setProperty('--ry', '0deg');
  };

  return (
    <div className="screen-stage" onPointerMove={onMove} onPointerLeave={onLeave}>
      <div className="screen-frame" ref={frame}>
        <div className="screen-bar">
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="screen-url">localhost:5180{tab.path}</span>
        </div>
        <img
          key={`${tab.screen}-${resolved}`}
          className="screen-img"
          src={asset(`screens/${tab.screen}-${resolved}.jpg`)}
          alt={t('features.screenAlt', { name: t(key(tab.id, 'Tab')) })}
          width={1440}
          height={900}
          loading="lazy"
          decoding="async"
        />
      </div>
    </div>
  );
}

export function Features() {
  const t = useT();
  const [active, setActive] = useState<TabId>('tools');
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const tab = TABS.find((x) => x.id === active)!;

  // Roving focus between tabs with the arrow keys (WAI-ARIA tabs pattern).
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((x) => x.id === active);
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = TABS[(i + delta + TABS.length) % TABS.length]!;
    setActive(next.id);
    tabRefs.current[next.id]?.focus();
  };

  return (
    <section className="section" id="features">
      <div className="container">
        <SectionHead index="03" label={t('features.label')} title={t('features.title')} lead={t('features.lead')} />
        <Reveal>
          <div className="tabs" role="tablist" aria-label={t('features.label')} onKeyDown={onKey}>
            {TABS.map((x) => (
              <button
                key={x.id}
                ref={(el) => {
                  tabRefs.current[x.id] = el;
                }}
                type="button"
                role="tab"
                id={`tab-${x.id}`}
                aria-selected={x.id === active}
                aria-controls="feature-panel"
                tabIndex={x.id === active ? 0 : -1}
                className={`tab ${x.id === active ? 'is-active' : ''}`}
                onClick={() => setActive(x.id)}
              >
                {t(key(x.id, 'Tab'))}
              </button>
            ))}
          </div>
          <div className="feature-panel" role="tabpanel" id="feature-panel" aria-labelledby={`tab-${active}`} key={active}>
            <div className="feature-copy">
              <h3>{t(key(active, 'Title'))}</h3>
              <p>{t(key(active, 'Body'))}</p>
              <ul className="checklist">
                {(['B1', 'B2', 'B3'] as const).map((b) => (
                  <li key={b}>
                    <Check size={16} />
                    {t(key(active, b))}
                  </li>
                ))}
              </ul>
            </div>
            <Screenshot tab={tab} />
          </div>
        </Reveal>

        <h3 className="more-title mono-label">
          <Boxes size={16} />
          {t('features.moreTitle')}
        </h3>
        <div className="more-grid">
          {MORE.map((m, i) => {
            const Icon = m.icon;
            return (
              <Reveal key={m.title} delay={(i % 4) * 60}>
                <article className="mini spotlight" onPointerMove={trackPointer}>
                  <Icon size={18} className="mini-icon" />
                  <h4>{t(m.title)}</h4>
                  <p>{t(m.body)}</p>
                </article>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

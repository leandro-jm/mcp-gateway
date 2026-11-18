import { Building2, ListFilter, Search, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Reveal } from '../components/Reveal';
import type { SiteMessageKey } from '../i18n/catalog';
import { useT } from '../i18n/I18nProvider';
import { trackPointer, useOnScreen, useReducedMotion } from '../lib/motion';
import { SectionHead } from './SectionHead';

type ServerId = 'hr' | 'finance' | 'support';

/** Example catalog: one tool can be published in more than one server. */
const CATALOG: Array<{ name: string; in: ServerId[] }> = [
  { name: 'hr_employee_get', in: ['hr', 'support'] },
  { name: 'hr_schedules_list', in: ['hr'] },
  { name: 'hr_timeentries_list', in: ['hr'] },
  { name: 'fin_invoice_get', in: ['finance'] },
  { name: 'fin_payments_list', in: ['finance'] },
  { name: 'crm_ticket_get', in: ['support'] },
  { name: 'crm_ticket_reply', in: ['support'] },
  { name: 'crm_customer_search', in: ['support', 'finance'] },
];

const SERVERS: Array<{ id: ServerId; name: SiteMessageKey }> = [
  { id: 'hr', name: 'servers.hr' },
  { id: 'finance', name: 'servers.finance' },
  { id: 'support', name: 'servers.support' },
];

const POINTS: Array<{ title: SiteMessageKey; body: SiteMessageKey; icon: LucideIcon }> = [
  { title: 'servers.curatedTitle', body: 'servers.curatedBody', icon: ListFilter },
  { title: 'servers.omniTitle', body: 'servers.omniBody', icon: Search },
  { title: 'servers.tenantTitle', body: 'servers.tenantBody', icon: Building2 },
];

export function Servers() {
  const t = useT();
  const reduce = useReducedMotion();
  const [ref, on] = useOnScreen<HTMLDivElement>();
  const [active, setActive] = useState<ServerId>('hr');
  const held = useRef(false);

  // Walks through the servers until the visitor points at one.
  useEffect(() => {
    if (!on || reduce) return;
    const id = setInterval(() => {
      if (!held.current) setActive((a) => SERVERS[(SERVERS.findIndex((s) => s.id === a) + 1) % SERVERS.length]!.id);
    }, 2600);
    return () => clearInterval(id);
  }, [on, reduce]);

  const hold = (id: ServerId) => {
    held.current = true;
    setActive(id);
  };

  return (
    <section className="section" id="servers">
      <div className="container">
        <SectionHead index="03" label={t('servers.label')} title={t('servers.title')} lead={t('servers.lead')} />
        <Reveal>
          <div className="servers" ref={ref}>
            <div className="catalog">
              <div className="catalog-head">
                <span className="mono-label">{t('servers.catalog')}</span>
                <span className="genui-note">{t('servers.example')}</span>
              </div>
              <ul>
                {CATALOG.map((tool) => (
                  <li key={tool.name} className={tool.in.includes(active) ? 'is-on' : ''}>
                    <i />
                    <code>{tool.name}</code>
                  </li>
                ))}
              </ul>
            </div>
            <div className="servers-flow" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <div className="server-cards">
              {SERVERS.map((s) => {
                const tools = CATALOG.filter((c) => c.in.includes(s.id));
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={`server-card ${s.id === active ? 'is-active' : ''}`}
                    aria-pressed={s.id === active}
                    onPointerEnter={() => hold(s.id)}
                    onFocus={() => hold(s.id)}
                    onClick={() => hold(s.id)}
                  >
                    <span className="server-top">
                      <b>{t(s.name)}</b>
                      <span className="server-count">{t('servers.tools', { count: tools.length })}</span>
                    </span>
                    <code className="server-url">/mcp/s/{s.id}</code>
                    <span className="server-tools">
                      {tools.map((c) => (
                        <span key={c.name}>{c.name}</span>
                      ))}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </Reveal>
        <div className="points">
          {POINTS.map((p, i) => {
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

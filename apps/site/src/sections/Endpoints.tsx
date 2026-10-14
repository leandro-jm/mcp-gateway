import { Reveal } from '../components/Reveal';
import type { SiteMessageKey } from '../i18n/catalog';
import { useT } from '../i18n/I18nProvider';
import { SectionHead } from './SectionHead';

const ROWS: Array<{ method: string; path: string; desc: SiteMessageKey }> = [
  { method: 'POST', path: '/mcp', desc: 'endpoints.mcp' },
  { method: 'POST', path: '/mcp/omni', desc: 'endpoints.omni' },
  { method: 'POST', path: '/mcp/s/:slug', desc: 'endpoints.servers' },
  { method: 'POST', path: '/mcp/observability', desc: 'endpoints.observability' },
  { method: 'GET', path: '/sdk/:tenant.ts', desc: 'endpoints.sdk' },
];

export function Endpoints() {
  const t = useT();
  return (
    <section className="section section-alt" id="endpoints">
      <div className="container">
        <SectionHead index="04" label={t('endpoints.label')} title={t('endpoints.title')} lead={t('endpoints.lead')} />
        <Reveal>
          <table className="endpoints">
            <thead>
              <tr>
                <th scope="col">{t('endpoints.colPath')}</th>
                <th scope="col">{t('endpoints.colPurpose')}</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.path}>
                  <td>
                    <span className={`method method-${r.method.toLowerCase()}`}>{r.method}</span>
                    <code>{r.path}</code>
                  </td>
                  <td>{t(r.desc)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Reveal>
      </div>
    </section>
  );
}

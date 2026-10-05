import { ScrollText } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import type { AuditEvent, Page } from '../api/types';
import { Badge, ErrorBox, fmtBytes, fmtDate, fmtNumber, JsonView, PageHeader, RefreshControls, Tabs } from '../components/ui';
import { useT } from '../i18n';
import { DECISION_LABEL, enumLabel } from '../lib/labels';
import { useAutoRefresh, useTenantQuery } from '../lib/hooks';

const ACTIONS = ['tools/call', 'composite.step', 'tool.enable', 'tool.disable', 'tool.override', 'projection.update', 'composite.create'];
const DECISIONS = ['allow', 'deny', 'error', 'applied', 'rejected'];

export function AuditPage() {
  const t = useT();
  const [filters, setFilters] = useState({ action: '', decision: '', toolName: '', clientId: '', from: '', to: '' });
  const [interval, setIntervalMs] = useAutoRefresh(0);
  const [openId, setOpenId] = useState<number | null>(null);
  const qs = new URLSearchParams({ limit: '200' });
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, k === 'from' || k === 'to' ? new Date(v).toISOString() : v);
  const events = useTenantQuery<Page<AuditEvent>>(['audit', qs.toString()], `/audit?${qs}`, { refetchMs: interval });
  const set = (k: keyof typeof filters) => (e: { target: { value: string } }) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  return (
    <>
      <PageHeader title={t('audit.title')} subtitle={t('audit.subtitle')} />
      <Tabs tabs={[{ id: 'events', label: t('audit.tabEvents'), icon: <ScrollText size={20} /> }]} value="events" onChange={() => undefined} />
      <div className="content">
        <div className="toolbar">
          <select className="select" style={{ width: 170 }} value={filters.action} onChange={set('action')} aria-label={t('common.action')}>
            <option value="">{t('audit.allActions')}</option>
            {ACTIONS.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <select className="select" style={{ width: 150 }} value={filters.decision} onChange={set('decision')} aria-label={t('common.decision')}>
            <option value="">{t('audit.allDecisions')}</option>
            {DECISIONS.map((d) => (
              <option key={d} value={d}>
                {enumLabel(t, DECISION_LABEL, d)}
              </option>
            ))}
          </select>
          <input className="input" style={{ width: 220 }} placeholder={t('audit.toolPlaceholder')} aria-label={t('common.tool')} value={filters.toolName} onChange={set('toolName')} />
          <input className="input" style={{ width: 160 }} placeholder={t('audit.clientPlaceholder')} aria-label={t('audit.colClient')} value={filters.clientId} onChange={set('clientId')} />
          <input className="input" type="datetime-local" style={{ width: 210 }} value={filters.from} onChange={set('from')} aria-label={t('audit.from')} />
          <input className="input" type="datetime-local" style={{ width: 210 }} value={filters.to} onChange={set('to')} aria-label={t('audit.to')} />
          <span className="count-label">{t('audit.count', { count: events.data?.total ?? 0 })}</span>
          <span className="spacer" />
          <RefreshControls onRefresh={() => void events.refetch()} interval={interval} setInterval={setIntervalMs} />
        </div>
        <ErrorBox error={events.error} />
        <table className="table">
          <thead>
            <tr>
              <th>{t('common.when')}</th>
              <th>{t('common.action')}</th>
              <th>{t('common.tool')}</th>
              <th>{t('common.decision')}</th>
              <th>{t('common.subject')}</th>
              <th>{t('audit.colClient')}</th>
              <th>{t('audit.colHttp')}</th>
              <th>{t('audit.colLatency')}</th>
              <th>{t('audit.colPii')}</th>
              <th>{t('audit.colSaved')}</th>
            </tr>
          </thead>
          <tbody>
            {(events.data?.items ?? []).map((e) => (
              <Fragment key={e.id}>
                <tr className="clickable" onClick={() => setOpenId(openId === e.id ? null : e.id)}>
                  <td className="muted">{fmtDate(e.ts)}</td>
                  <td className="mono">{e.action}</td>
                  <td className="mono">{e.toolName ?? '—'}</td>
                  <td>{e.decision && <Badge kind={e.decision}>{enumLabel(t, DECISION_LABEL, e.decision)}</Badge>}</td>
                  <td className="mono muted">{e.subject ?? '—'}</td>
                  <td className="mono muted">{e.clientId ?? '—'}</td>
                  <td className="mono">{e.statusCode ?? '—'}</td>
                  <td className="mono">{e.latencyMs !== null ? `${fmtNumber(e.latencyMs)} ms` : '—'}</td>
                  <td className="mono">{fmtNumber(e.redactionsCount ?? 0)}</td>
                  <td className="mono">{fmtBytes(e.projectedBytesSaved)}</td>
                </tr>
                {openId === e.id && (
                  <tr>
                    <td colSpan={10}>
                      {e.callId && e.action === 'tools/call' && (
                        <Link className="btn sm ghost" to={`/calls?open=${e.callId}`} style={{ marginBottom: 8 }}>
                          {t('calls.explain')}
                        </Link>
                      )}
                      <JsonView value={{ traceId: e.traceId, artifactId: e.artifactId, details: e.details }} maxHeight={240} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

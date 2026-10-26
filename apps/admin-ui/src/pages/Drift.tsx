import { useMutation } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import type { DriftEvent, Page } from '../api/types';
import { ToolDrawer } from '../components/ToolDrawer';
import { useToast } from '../components/toast';
import { Badge, fmtDate, LivePill, PageHeader, RefreshControls, Tabs } from '../components/ui';
import { useT } from '../i18n';
import { DRIFT_KIND_LABEL, enumLabel } from '../lib/labels';
import { useAutoRefresh, useInvalidate, useTenantQuery } from '../lib/hooks';

const KINDS: DriftEvent['kind'][] = ['breaking', 'removed', 'changed', 'added'];

export function DriftPage() {
  const t = useT();
  const [pending, setPending] = useState(true);
  const [kind, setKind] = useState('');
  const [interval, setIntervalMs] = useAutoRefresh(30000);
  const [open, setOpen] = useState<string | null>(null);
  const qs = new URLSearchParams({ limit: '200', ...(pending ? { pending: 'true' } : {}), ...(kind ? { kind } : {}) });
  const events = useTenantQuery<Page<DriftEvent>>(['drift', qs.toString()], `/drift-events?${qs}`, { refetchMs: interval });
  const invalidate = useInvalidate();
  const toast = useToast();
  const ack = useMutation({
    mutationFn: (id: string) => api(`/drift-events/${id}/ack`, { method: 'POST' }),
    onSuccess: () => {
      void invalidate('drift');
      toast('ok', t('drift.acknowledged'));
    },
    onError: (e) => toast('error', (e as Error).message),
  });
  const items = events.data?.items ?? [];
  return (
    <>
      <PageHeader
        title={t('drift.title')}
        subtitle={t('drift.subtitle')}
        right={<LivePill value={items.filter((e) => e.kind === 'breaking').length} label={t('drift.breaking')} />}
      />
      <Tabs tabs={[{ id: 'inbox', label: t('drift.tabInbox'), icon: <Inbox size={20} /> }]} value="inbox" onChange={() => undefined} />
      <div className="content">
        <div className="toolbar">
          <label className="check">
            <input type="checkbox" checked={pending} onChange={(e) => setPending(e.target.checked)} /> {t('drift.pendingOnly')}
          </label>
          <select className="select" style={{ width: 180 }} value={kind} onChange={(e) => setKind(e.target.value)} aria-label={t('drift.kindFilter')}>
            <option value="">{t('drift.allKinds')}</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {enumLabel(t, DRIFT_KIND_LABEL, k)}
              </option>
            ))}
          </select>
          <span className="count-label">{t('drift.count', { count: items.length })}</span>
          <span className="spacer" />
          <RefreshControls onRefresh={() => void events.refetch()} interval={interval} setInterval={setIntervalMs} />
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>{t('common.when')}</th>
              <th>{t('drift.colKind')}</th>
              <th>{t('common.tool')}</th>
              <th>{t('common.summary')}</th>
              <th>{t('common.owner')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id} className="clickable" onClick={() => setOpen(e.toolId)}>
                <td className="muted nowrap">{fmtDate(e.createdAt)}</td>
                <td>
                  <Badge kind={e.kind}>{enumLabel(t, DRIFT_KIND_LABEL, e.kind)}</Badge>
                </td>
                <td className="mono">{e.toolName}</td>
                <td>
                  {e.diff.summary ?? '—'}
                  {e.diff.fromVersion !== undefined && e.diff.toVersion !== undefined && (
                    <span className="mono dim">
                      {' '}
                      v{e.diff.fromVersion ?? '∅'}→v{e.diff.toVersion}
                    </span>
                  )}
                </td>
                <td className="muted">{e.ownerTeam ?? '—'}</td>
                <td onClick={(ev) => ev.stopPropagation()}>
                  {e.acknowledgedAt ? (
                    <span className="dim">{t('drift.acknowledgedBy', { user: e.acknowledgedBy })}</span>
                  ) : (
                    <button className="btn sm" onClick={() => ack.mutate(e.id)}>
                      {t('drift.acknowledge')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!events.isLoading && items.length === 0 && <p className="muted">{t('drift.empty')}</p>}
      </div>
      {open && <ToolDrawer toolId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

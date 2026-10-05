import { useQueries } from '@tanstack/react-query';
import { SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError } from '../api/client';
import { useSession } from '../api/session';
import type { Page, Projection, Tool } from '../api/types';
import { ToolDrawer } from '../components/ToolDrawer';
import { Badge, fmtBytes, PageHeader, Tabs } from '../components/ui';
import { useT } from '../i18n';
import { enumLabel, PROJECTION_STATUS_LABEL } from '../lib/labels';
import { useTenantQuery } from '../lib/hooks';

export function ProjectionsPage() {
  const t = useT();
  const { tenant } = useSession();
  const tools = useTenantQuery<Page<Tool>>(['tools', 'all'], '/tools?limit=500');
  const [open, setOpen] = useState<string | null>(null);
  const list = (tools.data?.items ?? []).filter((tool) => tool.state !== 'removed' && tool.outputSchema);
  const projections = useQueries({
    queries: list.map((tool) => ({
      queryKey: [tenant, 'projection', tool.id],
      queryFn: async () => {
        try {
          return await api<Projection>(`/tools/${tool.id}/projection`);
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) return null;
          throw e;
        }
      },
    })),
  });
  return (
    <>
      <PageHeader title={t('projections.title')} subtitle={t('projections.subtitle')} />
      <Tabs tabs={[{ id: 'list', label: t('projections.tabTools'), icon: <SlidersHorizontal size={20} /> }]} value="list" onChange={() => undefined} />
      <div className="content">
        <table className="table">
          <thead>
            <tr>
              <th>{t('common.tool')}</th>
              <th>{t('projections.colProjection')}</th>
              <th>{t('projections.colInclude')}</th>
              <th>{t('projections.colLimits')}</th>
              <th>_fields</th>
            </tr>
          </thead>
          <tbody>
            {list.map((tool, i) => {
              const p = projections[i]?.data;
              return (
                <tr key={tool.id} className="clickable" onClick={() => setOpen(tool.id)}>
                  <td className="mono">{tool.name}</td>
                  <td>{p ? <Badge kind={p.status}>{enumLabel(t, PROJECTION_STATUS_LABEL, p.status)}</Badge> : <span className="dim">{t('common.none')}</span>}</td>
                  <td className="mono muted" style={{ fontSize: 12 }}>
                    {p?.include.slice(0, 3).join(', ')}
                    {p && p.include.length > 3 ? ` +${p.include.length - 3}` : ''}
                  </td>
                  <td className="mono muted">{p ? [p.maxArrayItems && t('projections.maxItems', { count: p.maxArrayItems }), p.maxBytes && fmtBytes(p.maxBytes)].filter(Boolean).join(' · ') || '—' : '—'}</td>
                  <td>{p?.allowAgentFields ? <Badge kind="ok">{t('common.yes')}</Badge> : <span className="dim">{t('common.no')}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {open && <ToolDrawer toolId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

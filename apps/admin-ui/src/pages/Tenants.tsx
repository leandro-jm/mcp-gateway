import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import { useSession } from '../api/session';
import type { Page, Tenant } from '../api/types';
import { useToast } from '../components/toast';
import { Badge, Drawer, ErrorBox, Field, fmtDate, LivePill, PageHeader, SearchBox, Tabs } from '../components/ui';
import { useT, type UiMessageKey } from '../i18n';

const STATUS_LABELS: Record<Tenant['status'], UiMessageKey> = { active: 'tenants.statusActive', suspended: 'tenants.statusSuspended' };

/** Tenants of the platform (ADR-008): only the platform admin (no tenant of its own) creates, suspends and removes them. */
export function TenantsPage() {
  const t = useT();
  const { me, tenant, setTenant } = useSession();
  const platformAdmin = me.isAdmin && me.tenant === null;
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<Tenant | 'new' | null>(null);
  // same query as the session, so the tenant switcher follows every change made here
  const list = useQuery({
    queryKey: ['tenants'],
    queryFn: () => api<Page<Tenant>>('/tenants?limit=500', { tenant: null }),
    enabled: platformAdmin,
  });
  const qc = useQueryClient();
  const toast = useToast();
  const remove = useMutation({
    mutationFn: (tn: Tenant) => api(`/tenants/${tn.id}`, { method: 'DELETE', tenant: null }),
    onSuccess: (_, tn) => {
      toast('ok', t('tenants.removed'));
      const next = list.data?.items.find((x) => x.id !== tn.id);
      if (tn.slug === tenant && next) setTenant(next.slug);
      void qc.invalidateQueries({ queryKey: ['tenants'] });
    },
  });
  if (!platformAdmin) {
    return (
      <div className="content">
        <div className="alert warn">{t('tenants.platformOnly')}</div>
      </div>
    );
  }
  const needle = q.toLowerCase();
  const items = (list.data?.items ?? []).filter((tn) => !needle || tn.slug.includes(needle) || tn.name.toLowerCase().includes(needle));
  return (
    <>
      <PageHeader title={t('tenants.title')} subtitle={t('tenants.subtitle')} right={<LivePill value={list.data?.total ?? 0} label={t('tenants.title')} />} />
      <Tabs tabs={[{ id: 'list', label: t('tenants.tabList'), icon: <Building2 size={20} /> }]} value="list" onChange={() => undefined} />
      <div className="content">
        <div className="toolbar">
          <SearchBox value={q} onChange={setQ} placeholder={t('tenants.search')} />
          <span className="count-label">{t('tenants.count', { count: items.length })}</span>
          <span className="spacer" />
          <button className="btn primary" onClick={() => setEdit('new')}>
            {t('tenants.new')}
          </button>
        </div>
        <ErrorBox error={list.error ?? remove.error} />
        <table className="table">
          <thead>
            <tr>
              <th>{t('tenants.colTenant')}</th>
              <th>{t('common.status')}</th>
              <th>{t('tenants.colCreated')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((tn) => (
              <tr key={tn.id} className="clickable" onClick={() => setEdit(tn)}>
                <td>
                  <span className="mono">{tn.slug}</span>
                  <span className="muted"> · {tn.name}</span>
                  {tn.slug === tenant && (
                    <>
                      {' '}
                      <Badge kind="accent">{t('tenants.current')}</Badge>
                    </>
                  )}
                </td>
                <td>
                  <Badge kind={tn.status === 'active' ? 'enabled' : 'disabled'}>{t(STATUS_LABELS[tn.status])}</Badge>
                </td>
                <td className="muted">{fmtDate(tn.createdAt)}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  {tn.slug !== tenant && (
                    <button className="btn sm ghost" aria-label={t('tenants.switchToNamed', { name: tn.name })} onClick={() => setTenant(tn.slug)}>
                      {t('tenants.switchTo')}
                    </button>
                  )}
                  <button
                    className="btn sm ghost"
                    aria-label={t('common.removeNamed', { name: tn.slug })}
                    onClick={() => confirm(t('tenants.confirmDelete', { name: tn.slug })) && remove.mutate(tn)}
                  >
                    <Trash2 size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <TenantEditor tenant={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function TenantEditor({ tenant, onClose }: { tenant: Tenant | null; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ slug: tenant?.slug ?? '', name: tenant?.name ?? '', status: tenant?.status ?? ('active' as Tenant['status']) });
  const save = useMutation({
    mutationFn: () =>
      tenant
        ? api<Tenant>(`/tenants/${tenant.id}`, { method: 'PATCH', tenant: null, body: { name: form.name, ...(form.status !== tenant.status ? { status: form.status } : {}) } })
        : api<Tenant>('/tenants', { method: 'POST', tenant: null, body: { slug: form.slug, name: form.name } }),
    onSuccess: () => {
      toast('ok', t(tenant ? 'tenants.updated' : 'tenants.created'));
      void qc.invalidateQueries({ queryKey: ['tenants'] });
      onClose();
    },
  });
  return (
    <Drawer title={tenant ? tenant.slug : t('tenants.new')} subtitle={tenant?.name} onClose={onClose}>
      <div className="drawer-body">
        <div className="grid-2">
          <Field label={t('tenants.slug')} hint={t('tenants.slugHint')}>
            <input className="input mono" value={form.slug} disabled={Boolean(tenant)} onChange={(e) => setForm({ ...form, slug: e.target.value })} aria-label={t('tenants.slug')} />
          </Field>
          <Field label={t('common.name')}>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label={t('common.name')} />
          </Field>
          {tenant && (
            <Field label={t('common.status')} hint={t('tenants.statusHint')}>
              <select className="select" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Tenant['status'] })} aria-label={t('common.status')}>
                {Object.entries(STATUS_LABELS).map(([k, key]) => (
                  <option key={k} value={k}>
                    {t(key)}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <ErrorBox error={save.error} />
        <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending || !form.slug || !form.name}>
          {t('common.save')}
        </button>
      </div>
    </Drawer>
  );
}

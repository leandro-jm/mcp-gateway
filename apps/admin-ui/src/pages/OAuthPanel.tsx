import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useSession } from '../api/session';
import type { OAuthClient, OAuthClientMode, OAuthSettingsView, Page } from '../api/types';
import { ConnectedApps } from '../components/ConnectedApps';
import { TextSkeleton } from '../components/Skeleton';
import { useToast } from '../components/toast';
import { Badge, CodeBlock, ErrorBox, Field, fmtDate } from '../components/ui';
import { useT } from '../i18n';
import { useInvalidate, useTenantQuery } from '../lib/hooks';

interface Form {
  enabled: boolean;
  clients: OAuthClientMode;
  allowlist: string;
  accessTtlMinutes: string;
  refreshTtlDays: string;
}

const toForm = (v: OAuthSettingsView): Form => ({
  enabled: v.settings.enabled,
  clients: v.settings.clients,
  allowlist: v.settings.allowlist.join('\n'),
  accessTtlMinutes: v.settings.accessTtlMinutes ? String(v.settings.accessTtlMinutes) : '',
  refreshTtlDays: v.settings.refreshTtlDays ? String(v.settings.refreshTtlDays) : '',
});

/** App connections over OAuth (ADR-030): tenant switch and allowlist, the tenant's connected apps and, for platform admins, every known app. */
export function OAuthPanel() {
  const t = useT();
  const { me } = useSession();
  const view = useTenantQuery<OAuthSettingsView>(['settings', 'oauth'], '/settings/oauth');
  return (
    <div className="content stack" style={{ maxWidth: 980 }}>
      <ErrorBox error={view.error} />
      {view.isLoading && (
        <div className="panel">
          <div className="panel-body">
            <TextSkeleton lines={8} />
          </div>
        </div>
      )}
      {view.data && (
        <>
          {!view.data.platformEnabled && <div className="alert warn">{t('oauth.platformOff')}</div>}
          <SettingsCard view={view.data} />
          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">{t('oauth.appsPanel')}</span>
            </div>
            <div className="panel-body">
              <ConnectedApps basePath="/oauth/grants" showUser />
            </div>
          </div>
          {me.isAdmin && me.tenant === null && <PlatformClients />}
        </>
      )}
    </div>
  );
}

function SettingsCard({ view }: { view: OAuthSettingsView }) {
  const t = useT();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [form, setForm] = useState<Form>(toForm(view));
  useEffect(() => setForm(toForm(view)), [view]);
  const readOnly = !view.platformEnabled;
  const save = useMutation({
    mutationFn: () =>
      api<OAuthSettingsView>('/settings/oauth', {
        method: 'PUT',
        body: {
          enabled: form.enabled,
          clients: form.clients,
          allowlist: form.allowlist
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
          accessTtlMinutes: form.accessTtlMinutes ? Number(form.accessTtlMinutes) : null,
          refreshTtlDays: form.refreshTtlDays ? Number(form.refreshTtlDays) : null,
        },
      }),
    onSuccess: () => {
      toast('ok', t('settings.saved'));
      void invalidate('settings');
      void invalidate('oauth-grants');
    },
  });
  const on = view.settings.enabled && view.platformEnabled;
  const emptyList = form.clients === 'allowlist' && !form.allowlist.trim();

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">{t('oauth.settingsPanel')}</span>
        <Badge kind={on ? 'ok' : 'warn'}>{on ? t('oauth.statusOn') : t('oauth.statusOff')}</Badge>
      </div>
      <fieldset className="panel-body stack" data-testid="oauth-settings" disabled={readOnly} style={{ border: 0, margin: 0 }}>
        <p className="hint" style={{ margin: 0 }}>{t('oauth.intro')}</p>
        <label className="check">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> <strong>{t('oauth.enabled')}</strong>
        </label>
        <Field label={t('oauth.serverUrl')} hint={t('oauth.serverUrlHint')}>
          <CodeBlock code={`${view.issuer}/mcp/omni`} />
        </Field>
        <Field label={t('oauth.clients')}>
          <div className="stack" role="radiogroup" aria-label={t('oauth.clients')}>
            <label className="check">
              <input type="radio" name="oauth-clients" checked={form.clients === 'allowlist'} onChange={() => setForm({ ...form, clients: 'allowlist' })} /> {t('oauth.clientsAllowlist')}
            </label>
            <label className="check">
              <input type="radio" name="oauth-clients" checked={form.clients === 'any'} onChange={() => setForm({ ...form, clients: 'any' })} /> {t('oauth.clientsAny')}
            </label>
          </div>
        </Field>
        {form.clients === 'allowlist' && (
          <Field label={t('oauth.allowlist')} hint={t('oauth.allowlistHint')}>
            <textarea
              className="input mono"
              rows={4}
              aria-label={t('oauth.allowlist')}
              placeholder={'claude.ai\nchatgpt.com'}
              value={form.allowlist}
              onChange={(e) => setForm({ ...form, allowlist: e.target.value })}
            />
            {emptyList && form.enabled && <span className="hint">{t('oauth.allowlistEmpty')}</span>}
          </Field>
        )}
        <div className="grid-2">
          <Field label={t('oauth.accessTtl')} hint={t('oauth.ttlHint', { value: view.platformAccessTtlMinutes })}>
            <input
              className="input mono"
              inputMode="numeric"
              aria-label={t('oauth.accessTtl')}
              placeholder={String(view.platformAccessTtlMinutes)}
              value={form.accessTtlMinutes}
              onChange={(e) => setForm({ ...form, accessTtlMinutes: e.target.value.replace(/\D/g, '') })}
            />
          </Field>
          <Field label={t('oauth.refreshTtl')} hint={t('oauth.ttlHint', { value: view.platformRefreshTtlDays })}>
            <input
              className="input mono"
              inputMode="numeric"
              aria-label={t('oauth.refreshTtl')}
              placeholder={String(view.platformRefreshTtlDays)}
              value={form.refreshTtlDays}
              onChange={(e) => setForm({ ...form, refreshTtlDays: e.target.value.replace(/\D/g, '') })}
            />
          </Field>
        </div>
        <span className="hint">{view.dcrEnabled ? t('oauth.dcrOn') : t('oauth.dcrOff')}</span>
        <ErrorBox error={save.error} />
        <div>
          <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {t('oauth.save')}
          </button>
        </div>
      </fieldset>
    </div>
  );
}

/** Every app the authorization server knows (platform admin only): disable blocks it on all tenants. */
function PlatformClients() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const clients = useQuery({ queryKey: ['platform', 'oauth-clients'], queryFn: () => api<Page<OAuthClient>>('/platform/oauth/clients?limit=500', { tenant: null }) });
  const toggle = useMutation({
    mutationFn: ({ id, disabled }: { id: string; disabled: boolean }) =>
      api<OAuthClient>(`/platform/oauth/clients/${id}`, { method: 'PATCH', tenant: null, body: { disabled } }),
    onSuccess: () => {
      toast('ok', t('settings.saved'));
      void qc.invalidateQueries({ queryKey: ['platform', 'oauth-clients'] });
    },
  });
  const items = clients.data?.items ?? [];
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">{t('oauth.clientsPanel')}</span>
      </div>
      <div className="panel-body stack" data-testid="oauth-clients">
        <p className="hint" style={{ margin: 0 }}>{t('oauth.clientsIntro')}</p>
        <ErrorBox error={clients.error ?? toggle.error} />
        <table className="table" aria-busy={clients.isLoading}>
          <thead>
            <tr>
              <th>{t('oauth.app')}</th>
              <th>{t('oauth.policyClient')}</th>
              <th>{t('oauth.kind')}</th>
              <th>{t('oauth.activeGrants')}</th>
              <th>{t('oauth.lastUsed')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {!clients.isLoading && items.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  {t('oauth.clientsNone')}
                </td>
              </tr>
            )}
            {items.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.clientName} {c.disabledAt && <Badge kind="error">{t('oauth.disabled')}</Badge>}
                </td>
                <td className="mono dim">{c.policyClientId}</td>
                <td>
                  <Badge kind={c.kind === 'cimd' ? 'ok' : 'warn'}>{c.kind === 'cimd' ? t('oauth.verified') : t('oauth.unverified')}</Badge>
                </td>
                <td className="mono">{c.activeGrants}</td>
                <td className="muted nowrap">{fmtDate(c.lastUsedAt)}</td>
                <td>
                  {c.disabledAt ? (
                    <button className="btn sm" onClick={() => toggle.mutate({ id: c.id, disabled: false })} disabled={toggle.isPending}>
                      {t('oauth.enable')}
                    </button>
                  ) : (
                    <button
                      className="btn sm ghost"
                      onClick={() => confirm(t('oauth.disableConfirm', { name: c.clientName })) && toggle.mutate({ id: c.id, disabled: true })}
                      disabled={toggle.isPending}
                    >
                      {t('oauth.disable')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

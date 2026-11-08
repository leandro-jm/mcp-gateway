import { useMutation } from '@tanstack/react-query';
import { Unplug } from 'lucide-react';
import { api } from '../api/client';
import type { OAuthGrant, Page } from '../api/types';
import { useT } from '../i18n';
import { useInvalidate, useTenantQuery } from '../lib/hooks';
import { usePagination } from '../lib/pagination';
import { Pagination } from './Pagination';
import { SkeletonRows } from './Skeleton';
import { useToast } from './toast';
import { Badge, ErrorBox, fmtDate } from './ui';

/**
 * Apps connected over OAuth (ADR-030): the signed-in user's (`/me/oauth/grants`) or, for admins,
 * the tenant's (`/oauth/grants`, with the person). Disconnecting revokes the grant and its tokens.
 */
export function ConnectedApps({ basePath, showUser = false }: { basePath: string; showUser?: boolean }) {
  const t = useT();
  const toast = useToast();
  const invalidate = useInvalidate();
  const grants = useTenantQuery<Page<OAuthGrant>>(['oauth-grants', basePath], `${basePath}?limit=500`);
  const revoke = useMutation({
    mutationFn: (id: string) => api(`${basePath}/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('ok', t('oauth.disconnected'));
      void invalidate('oauth-grants');
    },
  });
  const items = grants.data?.items ?? [];
  const { rows, pager } = usePagination(items, { compact: true });
  const cols = showUser ? 6 : 5;
  const scopeLabel = (scope: string) => (scope === 'mcp' ? t('oauth.scopeMcp') : scope === 'offline_access' ? t('oauth.scopeOffline') : scope);

  return (
    <div className="stack" data-testid="connected-apps">
      <ErrorBox error={grants.error ?? revoke.error} />
      <table className="table" aria-busy={grants.isLoading}>
        <thead>
          <tr>
            <th>{t('oauth.app')}</th>
            {showUser && <th>{t('oauth.user')}</th>}
            <th>{t('oauth.scopes')}</th>
            <th>{t('oauth.connected')}</th>
            <th>{t('oauth.lastUsed')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {grants.isLoading && <SkeletonRows cols={cols} rows={2} />}
          {!grants.isLoading && items.length === 0 && (
            <tr>
              <td colSpan={cols} className="muted">
                {t('oauth.appsNone')}
              </td>
            </tr>
          )}
          {rows.map((g) => (
            <tr key={g.id}>
              <td>
                <div>{g.clientName}</div>
                <div className="row" style={{ gap: 6 }}>
                  <span className="mono dim">{g.policyClientId}</span>
                  <Badge kind={g.clientKind === 'cimd' ? 'ok' : 'warn'}>{g.clientKind === 'cimd' ? t('oauth.verified') : t('oauth.unverified')}</Badge>
                </div>
              </td>
              {showUser && <td className="mono">{g.username}</td>}
              <td className="muted">{g.scopes.map(scopeLabel).join(', ')}</td>
              <td className="muted nowrap">{fmtDate(g.createdAt)}</td>
              <td className="muted nowrap">{fmtDate(g.lastUsedAt)}</td>
              <td>
                <button
                  className="btn sm ghost"
                  aria-label={t('oauth.disconnectNamed', { name: g.clientName })}
                  title={t('oauth.disconnect')}
                  onClick={() => confirm(t('oauth.disconnectConfirm', { name: g.clientName })) && revoke.mutate(g.id)}
                  disabled={revoke.isPending}
                >
                  <Unplug size={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pagination {...pager} />
    </div>
  );
}

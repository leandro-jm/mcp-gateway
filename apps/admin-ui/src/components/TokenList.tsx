import { useMutation } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import type { ApiToken, ApiTokenCreated } from '../api/types';
import { useT } from '../i18n';
import { useInvalidate, useTenantQuery } from '../lib/hooks';
import { useToast } from './toast';
import { CodeBlock, ErrorBox, Field, fmtDate } from './ui';

/**
 * A user's API tokens (`/me/tokens` or `/users/:id/tokens`). The token value is shown
 * only once, right after creation (ADR-011).
 */
export function TokenList({ basePath }: { basePath: string }) {
  const t = useT();
  const tokens = useTenantQuery<{ items: ApiToken[] }>(['tokens', basePath], basePath);
  const invalidate = useInvalidate();
  const toast = useToast();
  const [name, setName] = useState('');
  const [days, setDays] = useState('');
  const [created, setCreated] = useState<ApiTokenCreated | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api<ApiTokenCreated>(basePath, { method: 'POST', body: { name, ...(days ? { expiresInDays: Number(days) } : {}) } }),
    onSuccess: (tok) => {
      setCreated(tok);
      setName('');
      setDays('');
      void invalidate('tokens', basePath);
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`${basePath}/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('ok', t('common.tokenRevoked'));
      void invalidate('tokens', basePath);
    },
  });
  const items = tokens.data?.items ?? [];
  return (
    <div className="stack">
      {created && (
        <div className="alert ok" data-testid="new-token">
          <strong>{t('common.tokenCopyNow')}</strong> {t('common.tokenShownOnce')}
          <div style={{ marginTop: 10 }}>
            <CodeBlock code={created.token} />
          </div>
          <button className="btn sm" style={{ marginTop: 10 }} onClick={() => setCreated(null)}>
            {t('common.tokenCopied')}
          </button>
        </div>
      )}
      <div className="grid-2">
        <Field label={t('common.name')} hint={<>{t('common.tokenNameHint')} <span className="mono">client:&lt;{t('common.tokenNameVar')}&gt;</span></>}>
          <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('common.example', { example: 'my-agent' })} aria-label={t('common.tokenName')} />
        </Field>
        <Field label={t('common.tokenExpiresInDays')} hint={t('common.tokenExpiresHint')}>
          <input className="input" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} aria-label={t('common.tokenExpiresInDays')} />
        </Field>
      </div>
      <ErrorBox error={create.error ?? revoke.error ?? tokens.error} />
      <div>
        <button className="btn primary" onClick={() => create.mutate()} disabled={!name || create.isPending}>
          {t('common.tokenGenerate')}
        </button>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>{t('common.name')}</th>
            <th>{t('common.tokenPrefix')}</th>
            <th>{t('common.tokenCreated')}</th>
            <th>{t('common.tokenLastUsed')}</th>
            <th>{t('common.tokenExpires')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                {t('common.tokenNone')}
              </td>
            </tr>
          )}
          {items.map((tk) => (
            <tr key={tk.id}>
              <td className="mono">{tk.name}</td>
              <td className="mono dim">{tk.prefix}…</td>
              <td className="muted">{fmtDate(tk.createdAt)}</td>
              <td className="muted">{fmtDate(tk.lastUsedAt)}</td>
              <td className="muted">{tk.expiresAt ? fmtDate(tk.expiresAt) : t('common.never')}</td>
              <td>
                <button className="btn sm ghost" aria-label={t('common.tokenRevokeNamed', { name: tk.name })} onClick={() => revoke.mutate(tk.id)}>
                  <Trash2 size={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

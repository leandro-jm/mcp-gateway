import { LOCALE_NAMES, LOCALES, type Locale } from '@mcp-gateway/i18n';
import { useMutation } from '@tanstack/react-query';
import { Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import { useSession } from '../api/session';
import type { Page, User } from '../api/types';
import { Editor } from '../components/Editor';
import { TokenList } from '../components/TokenList';
import { useToast } from '../components/toast';
import { Badge, Drawer, ErrorBox, Field, fmtDate, LivePill, PageHeader, SearchBox, Tabs } from '../components/ui';
import { useI18n, useT, type UiMessageKey } from '../i18n';
import { useInvalidate, useTenantQuery } from '../lib/hooks';
import { rich } from '../lib/rich';
import { parseJson } from '../lib/schema';

const ROLES = ['gateway-admin', 'tool-owner', 'agent', 'analytics-reader'];
const csv = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const KIND_LABELS: Record<User['kind'], UiMessageKey> = { human: 'users.kindHuman', service: 'users.kindService' };
const STATUS_LABELS: Record<User['status'], UiMessageKey> = { active: 'users.statusActive', disabled: 'users.statusDisabled' };

/** Tenant users (ADR-011): humans sign in to the Admin UI; `service` users are agents with tokens. */
export function UsersPage() {
  const t = useT();
  const { me, tenant } = useSession();
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<User | 'new' | null>(null);
  const users = useTenantQuery<Page<User>>(['users'], me.isAdmin ? '/users?limit=500' : null);
  const invalidate = useInvalidate();
  const toast = useToast();
  const remove = useMutation({
    mutationFn: (id: string) => api(`/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('ok', t('users.removed'));
      void invalidate('users');
    },
  });
  if (!me.isAdmin) {
    return (
      <div className="content">
        <div className="alert warn">{t('users.adminOnly')}</div>
      </div>
    );
  }
  const items = (users.data?.items ?? []).filter((u) => !q || u.username.includes(q) || (u.displayName ?? '').toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <PageHeader
        title={t('users.title')}
        subtitle={rich(t, 'users.subtitle', { tenant: <span className="mono">{tenant}</span> })}
        right={<LivePill value={users.data?.total ?? 0} label={t('users.title')} />}
      />
      <Tabs tabs={[{ id: 'list', label: t('users.tabList'), icon: <Users size={20} /> }]} value="list" onChange={() => undefined} />
      <div className="content">
        <div className="toolbar">
          <SearchBox value={q} onChange={setQ} placeholder={t('users.search')} />
          <span className="count-label">{t('users.count', { count: items.length })}</span>
          <span className="spacer" />
          <button className="btn primary" onClick={() => setEdit('new')}>
            {t('users.new')}
          </button>
        </div>
        <ErrorBox error={users.error ?? remove.error} />
        <table className="table">
          <thead>
            <tr>
              <th>{t('users.colUser')}</th>
              <th>{t('users.colKind')}</th>
              <th>{t('common.roles')}</th>
              <th>{t('common.groups')}</th>
              <th>{t('users.colLanguage')}</th>
              <th>{t('common.status')}</th>
              <th>{t('users.colCreated')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((u) => (
              <tr key={u.id} className="clickable" onClick={() => setEdit(u)}>
                <td>
                  <span className="mono">{u.username}</span>
                  {u.displayName && <span className="muted"> · {u.displayName}</span>}
                </td>
                <td>
                  <Badge>{t(KIND_LABELS[u.kind])}</Badge>
                </td>
                <td className="mono">{u.roles.join(', ') || '—'}</td>
                <td className="mono">{u.groups.join(', ') || '—'}</td>
                <td className="muted">{LOCALE_NAMES[u.locale] ?? u.locale ?? '—'}</td>
                <td>
                  <Badge kind={u.status === 'active' ? 'enabled' : 'disabled'}>{t(STATUS_LABELS[u.status])}</Badge>
                </td>
                <td className="muted nowrap">{fmtDate(u.createdAt)}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  {u.username !== me.sub && (
                    <button className="btn sm ghost" aria-label={t('common.removeNamed', { name: u.username })} onClick={() => confirm(t('common.confirmRemove', { name: u.username })) && remove.mutate(u.id)}>
                      <Trash2 size={16} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <UserEditor user={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

type EditorTab = 'profile' | 'password' | 'tokens';

function UserEditor({ user, onClose }: { user: User | null; onClose(): void }) {
  const { t, locale } = useI18n();
  const invalidate = useInvalidate();
  const toast = useToast();
  const [tab, setTab] = useState<EditorTab>('profile');
  const [form, setForm] = useState({
    username: user?.username ?? '',
    displayName: user?.displayName ?? '',
    kind: user?.kind ?? ('human' as User['kind']),
    password: '',
    roles: user?.roles.join(', ') ?? 'agent',
    groups: user?.groups.join(', ') ?? '',
    status: user?.status ?? ('active' as User['status']),
    locale: user?.locale ?? locale,
    attributes: JSON.stringify(user?.attributes ?? {}, null, 2),
  });
  const [newPassword, setNewPassword] = useState('');
  const save = useMutation({
    mutationFn: () => {
      const attrs = parseJson<Record<string, unknown>>(form.attributes);
      if (attrs.error) throw new Error(t('users.invalidAttributes', { error: attrs.error }));
      const common = { displayName: form.displayName || null, roles: csv(form.roles), groups: csv(form.groups), attributes: attrs.value, locale: form.locale };
      if (user) return api<User>(`/users/${user.id}`, { method: 'PATCH', body: { ...common, status: form.status } });
      return api<User>('/users', {
        method: 'POST',
        body: { ...common, username: form.username, kind: form.kind, ...(form.kind === 'human' && form.password ? { password: form.password } : {}) },
      });
    },
    onSuccess: () => {
      toast('ok', t(user ? 'users.updated' : 'users.created'));
      void invalidate('users');
      onClose();
    },
  });
  const setPassword = useMutation({
    mutationFn: () => api(`/users/${user!.id}/password`, { method: 'PUT', body: { password: newPassword } }),
    onSuccess: () => {
      toast('ok', t('users.passwordSet'));
      setNewPassword('');
      void invalidate('users');
    },
  });
  const tabs = [
    { id: 'profile' as const, label: t('users.tabProfile') },
    ...(user?.kind === 'human' ? [{ id: 'password' as const, label: t('users.tabPassword') }] : []),
    ...(user ? [{ id: 'tokens' as const, label: t('users.tabTokens') }] : []),
  ];
  return (
    <Drawer title={user ? user.username : t('users.new')} subtitle={user && <Badge>{t(KIND_LABELS[user.kind])}</Badge>} onClose={onClose}>
      {user && <Tabs<EditorTab> tabs={tabs} value={tab} onChange={setTab} />}
      <div className="drawer-body">
        {tab === 'profile' && (
          <>
            <div className="grid-2">
              <Field label={t('users.username')} hint={rich(t, 'users.usernameHint', { subject: <span className="mono">{t('users.usernameSubject')}</span> })}>
                <input className="input mono" value={form.username} disabled={Boolean(user)} onChange={(e) => setForm({ ...form, username: e.target.value })} aria-label={t('users.username')} />
              </Field>
              <Field label={t('common.name')}>
                <input className="input" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} aria-label={t('common.name')} />
              </Field>
              {!user && (
                <Field label={t('users.kind')} hint={t('users.kindHint')}>
                  <select className="select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as User['kind'] })} aria-label={t('users.kind')}>
                    {Object.entries(KIND_LABELS).map(([k, key]) => (
                      <option key={k} value={k}>
                        {t(key)}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {!user && form.kind === 'human' && (
                <Field label={t('users.password')} hint={t('users.passwordHint')}>
                  <input className="input" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} aria-label={t('users.password')} />
                </Field>
              )}
              <Field label={t('common.roles')} hint={ROLES.join(', ')}>
                <input className="input mono" value={form.roles} onChange={(e) => setForm({ ...form, roles: e.target.value })} aria-label={t('common.roles')} />
              </Field>
              <Field label={t('common.groups')} hint={t('users.groupsHint')}>
                <input className="input mono" value={form.groups} onChange={(e) => setForm({ ...form, groups: e.target.value })} aria-label={t('common.groups')} />
              </Field>
              <Field label={t('users.language')} hint={t('users.languageHint')}>
                <select className="select" value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value as Locale })} aria-label={t('users.language')}>
                  {LOCALES.map((l) => (
                    <option key={l} value={l} lang={l}>
                      {LOCALE_NAMES[l]}
                    </option>
                  ))}
                </select>
              </Field>
              {user && (
                <Field label={t('common.status')}>
                  <select className="select" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as User['status'] })} aria-label={t('common.status')}>
                    {Object.entries(STATUS_LABELS).map(([k, key]) => (
                      <option key={k} value={k}>
                        {t(key)}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
            <Field label={t('users.attributes')} hint={t('users.attributesHint', { example: '{"unidades": ["uni-1"]}' })}>
              <Editor value={form.attributes} onChange={(v) => setForm({ ...form, attributes: v })} height="120px" />
            </Field>
            <ErrorBox error={save.error} />
            <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending || !form.username}>
              {t('common.save')}
            </button>
          </>
        )}
        {tab === 'password' && user && (
          <>
            <Field label={t('users.newPassword')} hint={t('users.passwordHint')}>
              <input className="input" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} aria-label={t('users.newPassword')} />
            </Field>
            <ErrorBox error={setPassword.error} />
            <button className="btn primary" onClick={() => setPassword.mutate()} disabled={setPassword.isPending || newPassword.length < 8}>
              {t('users.setPassword')}
            </button>
          </>
        )}
        {tab === 'tokens' && user && <TokenList basePath={`/users/${user.id}/tokens`} />}
      </div>
    </Drawer>
  );
}

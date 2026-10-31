import { useMutation } from '@tanstack/react-query';
import { ArrowDown, Download, KeyRound, List, Pencil, Play } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import { useSession } from '../api/session';
import type { CrawlRun, Credential, Page, Source } from '../api/types';
import { Editor } from '../components/Editor';
import { FORMAT_LABEL, ImportWizard } from '../components/ImportWizard';
import { useToast } from '../components/toast';
import { Badge, CodeBlock, Drawer, EmptyState, ErrorBox, Field, fmtDate, JsonView, LivePill, PageHeader, RefreshControls, SearchBox, Tabs } from '../components/ui';
import { useT, type UiMessageKey } from '../i18n';
import { useAutoRefresh, useInvalidate, useTenantQuery } from '../lib/hooks';
import { CRAWL_STATUS_LABEL, CRAWL_TRIGGER_LABEL, enumLabel, SOURCE_STATUS_LABEL } from '../lib/labels';
import { rich } from '../lib/rich';
import { parseJson } from '../lib/schema';

type Tab = 'list' | 'credentials';

/** Crawl run stats shown in the runs table, in display order. */
const RUN_STATS: Array<[string, UiMessageKey]> = [
  ['created', 'sources.statCreated'],
  ['updated', 'sources.statUpdated'],
  ['breaking', 'sources.statBreaking'],
  ['removed', 'sources.statRemoved'],
  ['unchanged', 'sources.statUnchanged'],
];

export function SourcesPage() {
  const t = useT();
  const { me } = useSession();
  const [tab, setTab] = useState<Tab>('list');
  const [q, setQ] = useState('');
  const [interval, setIntervalMs] = useAutoRefresh();
  const [open, setOpen] = useState<Source | null>(null);
  const [creating, setCreating] = useState(false);
  const sources = useTenantQuery<Page<Source>>(['sources'], '/sources?limit=500', { refetchMs: interval });
  const credentials = useTenantQuery<{ items: Credential[] }>(['credentials'], me.isAdmin ? '/credentials' : null);
  const items = (sources.data?.items ?? []).filter((s) => !q || s.name.includes(q.toLowerCase()) || s.baseUrl.includes(q));
  const invalidate = useInvalidate();
  const toast = useToast();
  const crawl = useMutation({
    mutationFn: (id: string) => api<CrawlRun>(`/sources/${id}/crawl`, { method: 'POST' }),
    onSuccess: () => {
      toast('ok', t('sources.crawlQueued'));
      void invalidate('sources');
    },
    onError: (e) => toast('error', (e as Error).message),
  });

  return (
    <>
      <PageHeader title={t('sources.title')} right={<LivePill value={sources.data?.total ?? 0} label={t('sources.liveLabel')} />} />
      <Tabs<Tab>
        tabs={[
          { id: 'list', label: t('common.list'), icon: <List size={20} /> },
          ...(me.isAdmin ? [{ id: 'credentials' as const, label: t('sources.tabCredentials'), icon: <KeyRound size={20} /> }] : []),
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="content">
        {tab === 'list' && (
          <>
            <div className="toolbar">
              <SearchBox value={q} onChange={setQ} placeholder={t('sources.searchPlaceholder')} />
              <span className="count-label">{t('sources.count', { count: items.length })}</span>
              <span className="spacer" />
              <RefreshControls onRefresh={() => void sources.refetch()} interval={interval} setInterval={setIntervalMs} />
              {me.isAdmin && (
                <button className="btn primary" onClick={() => setCreating(true)}>
                  {t('import.title')}
                </button>
              )}
            </div>
            <ErrorBox error={sources.error} />
            {!sources.isLoading && items.length === 0 ? (
              <EmptyState
                title={t('sources.emptyTitle')}
                text={t('sources.emptyText', { state: t('sources.disabledPlural') })}
                tabs={[
                  { id: 'api', label: t('sources.emptyTabApi'), content: <><div className="label">{t('sources.createSource')}</div><CodeBlock highlightFirstWord code={`curl -X POST /admin/v1/sources -d '{"name":"rh","openapiUrl":"https://api/openapi.json","baseUrl":"https://api"}'`} /><div className="label">{t('sources.importCurl')}</div><CodeBlock highlightFirstWord code={`curl -X POST /admin/v1/sources/import -d '{"input":{"kind":"text","text":"curl https://api/users/42"},"target":{"kind":"new","name":"rh","baseUrl":"https://api"}}'`} /><div className="label">{t('sources.runCrawl')}</div><CodeBlock highlightFirstWord code="curl -X POST /admin/v1/sources/{id}/crawl" /></> },
                  { id: 'ui', label: t('sources.emptyTabUi'), content: <button className="btn primary" onClick={() => setCreating(true)}>{t('import.title')}</button> },
                ]}
                footer={<span>{rich(t, 'sources.emptyFooter', { state: <b>{t('sources.disabledPlural')}</b> })}</span>}
              />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th className="sorted">
                      {t('common.name')} <ArrowDown size={14} style={{ verticalAlign: -2 }} />
                    </th>
                    <th>{t('sources.baseUrl')}</th>
                    <th>{t('sources.spec')}</th>
                    <th>{t('common.status')}</th>
                    <th>{t('common.owner')}</th>
                    <th>{t('sources.schedule')}</th>
                    <th>{t('sources.lastCrawl')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((s) => (
                    <tr key={s.id} className="clickable" onClick={() => setOpen(s)}>
                      <td className="mono">{s.name}</td>
                      <td className="mono muted">{s.baseUrl}</td>
                      <td className="muted">
                        {s.hasInlineSpec ? t('sources.specInline') : t('sources.specUrl')}
                        {s.importMeta?.format && ` · ${t(FORMAT_LABEL[s.importMeta.format])}`}
                      </td>
                      <td>
                        <Badge kind={s.status === 'active' ? 'ok' : 'warn'}>{enumLabel(t, SOURCE_STATUS_LABEL, s.status)}</Badge>
                      </td>
                      <td className="muted">{s.ownerTeam ?? '—'}</td>
                      <td className="mono muted">{s.crawlSchedule ?? t('sources.scheduleManual')}</td>
                      <td className="muted nowrap">{fmtDate(s.lastCrawlAt)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <button className="btn sm" onClick={() => crawl.mutate(s.id)} disabled={crawl.isPending}>
                          <Play size={14} /> {t('sources.crawl')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
        {tab === 'credentials' && <CredentialsTab items={credentials.data?.items ?? []} />}
      </div>
      {open && <SourceDrawer source={open} credentials={credentials.data?.items ?? []} canEdit={me.isAdmin} onSaved={setOpen} onClose={() => setOpen(null)} />}
      {creating && (
        <ImportWizard
          credentials={credentials.data?.items ?? []}
          sources={sources.data?.items ?? []}
          onClose={() => setCreating(false)}
          onImported={(s) => {
            setCreating(false);
            setOpen(s);
          }}
        />
      )}
    </>
  );
}

/** Saves the inline OpenAPI document of the source as a JSON file. */
async function downloadSpec(source: Source) {
  const spec = await api<unknown>(`/sources/${source.id}/openapi`);
  const href = URL.createObjectURL(new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href, download: `${source.name}.openapi.json` });
  a.click();
  URL.revokeObjectURL(href);
}

type SourceForm = { baseUrl: string; credentialId: string; ownerTeam: string; crawlSchedule: string };

const formOf = (s: Source): SourceForm => ({ baseUrl: s.baseUrl, credentialId: s.credentialId ?? '', ownerTeam: s.ownerTeam ?? '', crawlSchedule: s.crawlSchedule ?? '' });

function SourceDrawer({ source, credentials, canEdit, onSaved, onClose }: { source: Source; credentials: Credential[]; canEdit: boolean; onSaved(s: Source): void; onClose(): void }) {
  const t = useT();
  const toast = useToast();
  const invalidate = useInvalidate();
  const runs = useTenantQuery<{ items: CrawlRun[] }>(['sources', source.id, 'runs'], `/sources/${source.id}/crawl-runs`, { refetchMs: 4000 });
  const [form, setForm] = useState<SourceForm | null>(null);
  const set = (k: keyof SourceForm) => (e: { target: { value: string } }) => setForm((f) => f && { ...f, [k]: e.target.value });
  const save = useMutation({
    mutationFn: (f: SourceForm) =>
      api<Source>(`/sources/${source.id}`, {
        method: 'PATCH',
        body: { baseUrl: f.baseUrl.trim(), credentialId: f.credentialId || null, ownerTeam: f.ownerTeam.trim() || null, crawlSchedule: f.crawlSchedule.trim() || null },
      }),
    onSuccess: (s) => {
      toast('ok', t('sources.saved'));
      setForm(null);
      onSaved(s);
      void invalidate('sources');
    },
  });
  const credential = credentials.find((c) => c.id === source.credentialId);
  const meta = source.importMeta;
  return (
    <Drawer
      title={source.name}
      subtitle={<span className="mono muted">{source.baseUrl}</span>}
      actions={
        <>
          {canEdit && !form && (
            <button className="btn sm" onClick={() => setForm(formOf(source))}>
              <Pencil size={14} /> {t('common.edit')}
            </button>
          )}
          {source.hasInlineSpec && (
            <button className="btn sm" onClick={() => downloadSpec(source).catch((e: Error) => toast('error', e.message))}>
              <Download size={14} /> {t('import.downloadSpec')}
            </button>
          )}
        </>
      }
      onClose={onClose}
    >
      <div className="drawer-body stack">
        {form && (
          <div className="stack">
            <Field label={t('sources.baseUrl')}>
              <input className="input mono" value={form.baseUrl} onChange={set('baseUrl')} aria-label={t('sources.baseUrl')} />
            </Field>
            <div className="grid-2">
              <Field label={t('sources.credential')}>
                <select className="select" value={form.credentialId} onChange={set('credentialId')} aria-label={t('sources.credential')}>
                  <option value="">{t('common.none')}</option>
                  {credentials.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.type})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('common.ownerTeam')}>
                <input className="input" value={form.ownerTeam} onChange={set('ownerTeam')} aria-label={t('common.ownerTeam')} />
              </Field>
            </div>
            <Field label={t('sources.scheduleCron')} hint={t('common.example', { example: '"0 */6 * * *"' })}>
              <input className="input mono" value={form.crawlSchedule} onChange={set('crawlSchedule')} aria-label={t('sources.scheduleCron')} />
            </Field>
            <p className="hint">{t('sources.editHint')}</p>
            <ErrorBox error={save.error} />
            <div className="row">
              <button className="btn" onClick={() => setForm(null)} disabled={save.isPending}>
                {t('common.cancel')}
              </button>
              <button className="btn primary" onClick={() => save.mutate(form)} disabled={save.isPending || !form.baseUrl.trim()}>
                {t('common.save')}
              </button>
            </div>
          </div>
        )}
        <dl className="kv">
          <dt>OpenAPI</dt>
          <dd className="mono">
            {source.openapiUrl ?? t('sources.specInline')}
            {source.specFormat === 'postman' && ` (${t('import.formatPostman')})`}
          </dd>
          {meta?.format && (
            <>
              <dt>{t('import.lastImport')}</dt>
              <dd>{t('import.lastImportValue', { format: t(FORMAT_LABEL[meta.format]), date: fmtDate(meta.importedAt) })}</dd>
            </>
          )}
          <dt>{t('sources.credential')}</dt>
          <dd className="mono">{credential ? `${credential.name} (${credential.type})` : (source.credentialId ?? '—')}</dd>
          <dt>{t('common.ownerTeam')}</dt>
          <dd>{source.ownerTeam ?? '—'}</dd>
          <dt>{t('sources.schedule')}</dt>
          <dd className="mono">{source.crawlSchedule ?? t('sources.scheduleManual')}</dd>
        </dl>
        <div className="label">{t('sources.crawlRuns')}</div>
        <table className="table">
          <thead>
            <tr>
              <th>{t('common.status')}</th>
              <th>{t('sources.trigger')}</th>
              <th>{t('sources.result')}</th>
              <th>{t('sources.started')}</th>
            </tr>
          </thead>
          <tbody>
            {(runs.data?.items ?? []).map((r) => (
              <tr key={r.id}>
                <td>
                  <Badge kind={r.status}>{enumLabel(t, CRAWL_STATUS_LABEL, r.status)}</Badge>
                </td>
                <td className="muted">{enumLabel(t, CRAWL_TRIGGER_LABEL, r.trigger)}</td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {r.error ? (
                    <span style={{ color: 'var(--danger)' }}>{r.error}</span>
                  ) : (
                    RUN_STATS.filter(([k]) => r.stats[k] !== undefined)
                      .map(([k, label]) => `${t(label)}=${String(r.stats[k])}`)
                      .join(' · ')
                  )}
                </td>
                <td className="muted nowrap">{fmtDate(r.startedAt ?? r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Drawer>
  );
}

function CredentialsTab({ items }: { items: Credential[] }) {
  const t = useT();
  const invalidate = useInvalidate();
  const toast = useToast();
  const [draft, setDraft] = useState(
    JSON.stringify({ name: 'rh-oauth', type: 'oauth2_client_credentials', config: { tokenUrl: 'https://api/oauth/token', clientId: '', clientSecret: '' } }, null, 2),
  );
  const create = useMutation({
    mutationFn: () => {
      const p = parseJson(draft);
      if (p.error) throw new Error(t('common.invalidJson', { error: p.error }));
      return api<Credential>('/credentials', { method: 'POST', body: p.value });
    },
    onSuccess: () => {
      toast('ok', t('sources.credentialSaved'));
      void invalidate('credentials');
    },
  });
  return (
    <div className="split panel">
      <div className="panel-body">
        <div className="label" style={{ marginBottom: 12 }}>
          {t('sources.credentialsTitle')}
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>{t('common.name')}</th>
              <th>{t('common.type')}</th>
              <th>{t('sources.publicConfig')}</th>
              <th>{t('sources.rotated')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.name}</td>
                <td>
                  <Badge>{c.type}</Badge>
                </td>
                <td>
                  <JsonView value={c.config} maxHeight={90} />
                </td>
                <td className="muted nowrap">{fmtDate(c.rotatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel-body stack">
        <div className="label">{t('sources.newCredential')}</div>
        <Editor value={draft} onChange={setDraft} height="240px" label={t('sources.newCredential')} />
        <ErrorBox error={create.error} />
        <button className="btn primary" onClick={() => create.mutate()} disabled={create.isPending}>
          {t('sources.saveCredential')}
        </button>
      </div>
    </div>
  );
}

import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDown, LayoutGrid, List } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { useSession } from '../api/session';
import type { Page, Snippets, Tool, VirtualServer } from '../api/types';
import { useToast } from '../components/toast';
import { Badge, CodeBlock, Drawer, EmptyState, ErrorBox, Field, LivePill, PageHeader, RefreshControls, SearchBox, Tabs } from '../components/ui';
import { useT } from '../i18n';
import { useAutoRefresh, useInvalidate, useTenantQuery } from '../lib/hooks';
import { enumLabel, TOOL_STATE_LABEL } from '../lib/labels';
import { rich } from '../lib/rich';
import { lines } from '../lib/schema';

export function SnippetTabs({ serverId }: { serverId: string }) {
  const t = useT();
  const { tenant } = useSession();
  const sn = useQuery({ queryKey: [tenant, 'snippets', serverId], queryFn: () => api<Snippets>(`/virtual-servers/${serverId}/snippets`) });
  const [tab, setTab] = useState<'claude' | 'generic'>('claude');
  if (!sn.data) return <div className="loading">{t('servers.loadingSnippets')}</div>;
  return (
    <div className="panel">
      <Tabs<'claude' | 'generic'>
        tabs={[
          { id: 'claude', label: t('servers.tabClaude') },
          { id: 'generic', label: t('servers.tabGeneric') },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="panel-body stack">
        {tab === 'claude' && (
          <>
            <div className="label">Claude Code (CLI)</div>
            <CodeBlock highlightFirstWord code={sn.data.snippets.claude} />
            <div className="label">.mcp.json</div>
            <CodeBlock code={JSON.stringify(sn.data.snippets.claudeJson, null, 2)} />
          </>
        )}
        {tab === 'generic' && <CodeBlock code={sn.data.snippets.generic} />}
        <div className="hint">
          {rich(t, 'servers.tokenHint', { link: <Link to="/tokens">{t('shell.navTokens')}</Link>, header: <span className="mono">Authorization: Bearer</span> })}
        </div>
      </div>
    </div>
  );
}

export function ServersPage() {
  const t = useT();
  const [q, setQ] = useState('');
  const [interval, setIntervalMs] = useAutoRefresh();
  const [edit, setEdit] = useState<VirtualServer | 'new' | null>(null);
  const servers = useTenantQuery<{ items: VirtualServer[] }>(['servers'], '/virtual-servers', { refetchMs: interval });
  const items = (servers.data?.items ?? []).filter((s) => !q || s.slug.includes(q) || (s.name ?? '').toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <PageHeader title={t('servers.title')} right={<LivePill value={servers.data?.items.length ?? 0} label={t('servers.liveLabel')} />} />
      <Tabs tabs={[{ id: 'list', label: t('common.list'), icon: <List size={20} /> }]} value="list" onChange={() => undefined} />
      <div className="content">
        <div className="toolbar">
          <SearchBox value={q} onChange={setQ} placeholder={t('servers.searchPlaceholder')} />
          <span className="count-label">{t('servers.count', { count: items.length })}</span>
          <span className="spacer" />
          <RefreshControls onRefresh={() => void servers.refetch()} interval={interval} setInterval={setIntervalMs} />
          <button className="btn primary" onClick={() => setEdit('new')}>
            {t('servers.createMcp')}
          </button>
        </div>
        <ErrorBox error={servers.error} />
        {!servers.isLoading && items.length === 0 ? (
          <EmptyState
            title={t('servers.emptyTitle')}
            text={t('servers.emptyText')}
            tabs={[
              { id: 'claude', label: t('servers.tabClaude'), content: <><div className="label">{t('servers.connect')}</div><CodeBlock highlightFirstWord code='claude mcp add --transport http rh-gestor https://gateway/mcp/s/rh-gestor --header "Authorization: Bearer $TOKEN"' /></> },
              { id: 'generic', label: t('servers.tabGeneric'), content: <CodeBlock highlightFirstWord code={`curl https://gateway/mcp/s/rh-gestor -H 'Authorization: Bearer $TOKEN' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`} /> },
            ]}
            footer={
              <>
                <LayoutGrid size={20} />
                <span>{rich(t, 'servers.emptyFooter', { native: <b>/mcp/s/:slug</b>, omni: <b>/mcp/s/:slug/omni</b> })}</span>
              </>
            }
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th className="sorted">
                  {t('servers.slug')} <ArrowDown size={14} style={{ verticalAlign: -2 }} />
                </th>
                <th>{t('common.name')}</th>
                <th>{t('servers.mode')}</th>
                <th>{t('servers.selection')}</th>
                <th>{t('common.owner')}</th>
                <th>{t('servers.endpoint')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id} className="clickable" onClick={() => setEdit(s)}>
                  <td className="mono">{s.slug}</td>
                  <td>{s.name ?? '—'}</td>
                  <td>
                    <Badge kind={s.mode === 'omni' ? 'accent' : undefined}>{s.mode}</Badge>
                  </td>
                  <td className="muted mono" style={{ fontSize: 13 }}>
                    {[...(s.toolSelector.tools ?? []), ...(s.toolSelector.patterns ?? []), ...(s.toolSelector.tags ?? []).map((tag) => `#${tag}`)].slice(0, 4).join(', ')}
                  </td>
                  <td className="muted">{s.ownerTeam ?? '—'}</td>
                  <td className="mono muted" style={{ fontSize: 13 }}>
                    {s.mode === 'omni' ? s.endpoints.omni : s.endpoints.mcp}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {edit && <ServerEditor server={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function ServerEditor({ server, onClose }: { server: VirtualServer | null; onClose(): void }) {
  const t = useT();
  const invalidate = useInvalidate();
  const toast = useToast();
  const tools = useTenantQuery<Page<Tool>>(['tools', 'all'], '/tools?limit=500');
  const [form, setForm] = useState({
    slug: server?.slug ?? '',
    name: server?.name ?? '',
    description: server?.description ?? '',
    instructions: server?.instructions ?? '',
    mode: server?.mode ?? 'full',
    tools: new Set(server?.toolSelector.tools ?? []),
    patterns: (server?.toolSelector.patterns ?? []).join('\n'),
    tags: (server?.toolSelector.tags ?? []).join(', '),
  });
  const [filter, setFilter] = useState('');
  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...(server ? {} : { slug: form.slug }),
        name: form.name || null,
        description: form.description || null,
        instructions: form.instructions || null,
        mode: form.mode,
        toolSelector: {
          tools: [...form.tools],
          patterns: lines(form.patterns),
          tags: form.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
        },
      };
      return server ? api<VirtualServer>(`/virtual-servers/${server.id}`, { method: 'PATCH', body }) : api<VirtualServer>('/virtual-servers', { method: 'POST', body });
    },
    onSuccess: () => {
      toast('ok', t('servers.saved'));
      void invalidate('servers');
      onClose();
    },
  });
  const toggle = (name: string) =>
    setForm((f) => {
      const next = new Set(f.tools);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return { ...f, tools: next };
    });
  const list = (tools.data?.items ?? []).filter((tool) => tool.state !== 'removed' && (!filter || tool.name.includes(filter)));
  return (
    <Drawer title={server ? server.slug : t('servers.newMcp')} onClose={onClose}>
      <div className="drawer-body stack">
        <div className="grid-2">
          <Field label={t('servers.slug')}>
            <input className="input mono" value={form.slug} disabled={Boolean(server)} onChange={(e) => setForm({ ...form, slug: e.target.value })} aria-label={t('servers.slug')} />
          </Field>
          <Field label={t('common.name')}>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label={t('common.name')} />
          </Field>
        </div>
        <Field label={t('common.description')}>
          <input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} aria-label={t('common.description')} />
        </Field>
        <Field label={t('servers.instructions')}>
          <textarea className="textarea" style={{ fontFamily: 'var(--font-sans)' }} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} aria-label={t('servers.instructions')} />
        </Field>
        <Field label={t('servers.mode')}>
          <select className="select" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as 'full' | 'omni' })} aria-label={t('servers.mode')}>
            <option value="full">{t('servers.modeFull')}</option>
            <option value="omni">{t('servers.modeOmni')}</option>
          </select>
        </Field>
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">{t('servers.toolsSelected', { count: form.tools.size })}</span>
            <input className="input" style={{ width: 240, minHeight: 34 }} placeholder={t('common.filterPlaceholder')} aria-label={t('common.filterPlaceholder')} value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <div className="panel-body" style={{ maxHeight: 280, overflow: 'auto' }}>
            {list.map((tool) => (
              <label key={tool.id} className="check" style={{ display: 'flex', padding: '4px 0' }}>
                <input type="checkbox" checked={form.tools.has(tool.name)} onChange={() => toggle(tool.name)} />
                <span className="mono">{tool.name}</span>
                <Badge kind={tool.state}>{enumLabel(t, TOOL_STATE_LABEL, tool.state)}</Badge>
                {tool.kind === 'composite' && <Badge kind="accent">{t('common.toolKindComposite')}</Badge>}
              </label>
            ))}
          </div>
        </div>
        <div className="grid-2">
          <Field label={t('servers.patterns')}>
            <textarea className="textarea" value={form.patterns} onChange={(e) => setForm({ ...form, patterns: e.target.value })} aria-label={t('servers.patterns')} />
          </Field>
          <Field label={t('servers.tags')}>
            <input className="input" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} aria-label={t('servers.tags')} />
          </Field>
        </div>
        <ErrorBox error={save.error} />
        <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>
          {server ? t('common.save') : t('servers.publishMcp')}
        </button>
        {server && (
          <>
            <div className="label">{t('servers.connection')}</div>
            <SnippetTabs serverId={server.id} />
          </>
        )}
      </div>
    </Drawer>
  );
}

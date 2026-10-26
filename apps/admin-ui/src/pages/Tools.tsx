import { useMutation } from '@tanstack/react-query';
import { ArrowDown, List, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api } from '../api/client';
import { useSession } from '../api/session';
import type { Page, Source, Tool } from '../api/types';
import { Editor } from '../components/Editor';
import { KindBadge, StateBadge, ToolDrawer } from '../components/ToolDrawer';
import { useToast } from '../components/toast';
import { ErrorBox, Field, FiltersButton, fmtDate, LivePill, PageHeader, RefreshControls, SearchBox, Tabs } from '../components/ui';
import { useT } from '../i18n';
import { useAutoRefresh, useInvalidate, useTenantQuery } from '../lib/hooks';
import { enumLabel, TOOL_KIND_LABEL, TOOL_STATE_LABEL } from '../lib/labels';
import { rich } from '../lib/rich';
import { parseJson } from '../lib/schema';

type Tab = 'list' | 'manual';

export function ToolsPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>('list');
  const [q, setQ] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [state, setState] = useState(params.get('state') ?? '');
  const [kind, setKind] = useState('');
  const [owner, setOwner] = useState('');
  const [interval, setIntervalMs] = useAutoRefresh();
  const qs = new URLSearchParams({ limit: '500', ...(state ? { state } : {}), ...(kind ? { kind } : {}), ...(owner ? { ownerTeam: owner } : {}) });
  const tools = useTenantQuery<Page<Tool>>(['tools', qs.toString()], `/tools?${qs}`, { refetchMs: interval });
  const sources = useTenantQuery<Page<Source>>(['sources'], '/sources?limit=500');
  const enabled = useTenantQuery<Page<Tool>>(['tools', 'enabled-count'], '/tools?state=enabled&limit=1', { refetchMs: interval });
  const sourceName = new Map((sources.data?.items ?? []).map((s) => [s.id, s.name]));
  const open = params.get('open');
  const filtered = useMemo(() => {
    const needle = q.toLowerCase();
    return (tools.data?.items ?? []).filter((tool) => !needle || tool.name.toLowerCase().includes(needle) || tool.description.toLowerCase().includes(needle));
  }, [tools.data, q]);
  const activeFilters = [state, kind, owner].filter(Boolean).length;

  return (
    <>
      <PageHeader title={t('tools.title')} right={<LivePill value={enabled.data?.total ?? 0} label={t('tools.liveLabel')} />} />
      <Tabs<Tab>
        tabs={[
          { id: 'list', label: t('common.list'), icon: <List size={20} /> },
          { id: 'manual', label: t('tools.newManual'), icon: <Plus size={20} /> },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="content">
        {tab === 'list' && (
          <>
            <div className="toolbar">
              <SearchBox value={q} onChange={setQ} placeholder={t('tools.searchPlaceholder')} />
              <FiltersButton active={activeFilters} onClick={() => setShowFilters((s) => !s)} />
              <span className="count-label">{t('common.toolCount', { count: filtered.length })}</span>
              <span className="spacer" />
              <RefreshControls onRefresh={() => void tools.refetch()} interval={interval} setInterval={setIntervalMs} />
              <button className="btn primary" onClick={() => setTab('manual')}>
                {t('tools.newManual')}
              </button>
            </div>
            {showFilters && (
              <div className="panel" style={{ marginBottom: 20 }}>
                <div className="panel-body row" style={{ flexWrap: 'wrap' }}>
                  <Field label={t('common.state')}>
                    <select className="select" value={state} onChange={(e) => setState(e.target.value)} aria-label={t('tools.stateFilter')}>
                      <option value="">{t('common.all')}</option>
                      {['disabled', 'enabled', 'deprecated', 'removed'].map((s) => (
                        <option key={s} value={s}>
                          {enumLabel(t, TOOL_STATE_LABEL, s)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('common.type')}>
                    <select className="select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label={t('tools.kindFilter')}>
                      <option value="">{t('common.all')}</option>
                      {['openapi', 'manual', 'composite'].map((s) => (
                        <option key={s} value={s}>
                          {enumLabel(t, TOOL_KIND_LABEL, s)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('common.owner')}>
                    <input className="input" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="team-rh" aria-label={t('tools.ownerFilter')} />
                  </Field>
                </div>
              </div>
            )}
            <ErrorBox error={tools.error} />
            <table className="table" data-testid="tools-table">
              <thead>
                <tr>
                  <th className="sorted">
                    {t('common.name')} <ArrowDown size={14} style={{ verticalAlign: -2 }} />
                  </th>
                  <th>{t('common.state')}</th>
                  <th>{t('common.type')}</th>
                  <th>{t('common.source')}</th>
                  <th>{t('common.owner')}</th>
                  <th>{t('common.version')}</th>
                  <th>{t('toolDrawer.updated')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((tool) => (
                  <tr key={tool.id} className="clickable" onClick={() => setParams({ open: tool.id })}>
                    <td>
                      <div className="mono">{tool.name}</div>
                      <div className="muted" style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {tool.description}
                      </div>
                    </td>
                    <td>
                      <StateBadge state={tool.state} />
                    </td>
                    <td>
                      <KindBadge kind={tool.kind} />
                    </td>
                    <td className="mono muted">{tool.sourceId ? (sourceName.get(tool.sourceId) ?? '—') : '—'}</td>
                    <td className="muted nowrap">{tool.ownerTeam ?? '—'}</td>
                    <td className="mono">v{tool.version}</td>
                    <td className="muted nowrap">{fmtDate(tool.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!tools.isLoading && filtered.length === 0 && <p className="muted">{t('tools.empty')}</p>}
          </>
        )}
        {tab === 'manual' && <ManualToolForm sources={sources.data?.items ?? []} onCreated={(id) => {
          setTab('list');
          setParams({ open: id });
        }} />}
      </div>
      {open && <ToolDrawer toolId={open} onClose={() => setParams({})} />}
    </>
  );
}

const MANUAL_EXAMPLE = {
  name: 'rh_banco_horas_relatorio',
  title: 'Relatório de banco de horas',
  description: 'Saldo, créditos e débitos de banco de horas de um colaborador na competência.',
  method: 'GET',
  path: '/relatorios/banco-horas/{colaborador_id}',
  params: [
    { name: 'colaborador_id', in: 'path' },
    { name: 'competencia', in: 'query', schema: { type: 'string' } },
  ],
  exampleResponse: { colaborador_id: 'col-1', competencia: '2026-09', saldo_minutos: -30 },
};

function ManualToolForm({ sources, onCreated }: { sources: Source[]; onCreated(id: string): void }) {
  const t = useT();
  const { me } = useSession();
  const toast = useToast();
  const invalidate = useInvalidate();
  const navigate = useNavigate();
  const [sourceId, setSourceId] = useState('');
  const [spec, setSpec] = useState(JSON.stringify(MANUAL_EXAMPLE, null, 2));
  const create = useMutation({
    mutationFn: () => {
      const p = parseJson<Record<string, unknown>>(spec);
      if (p.error) throw new Error(t('common.invalidJson', { error: p.error }));
      return api<Tool>('/tools/manual', { method: 'POST', body: { ...p.value, sourceId: sourceId || sources[0]?.id } });
    },
    onSuccess: (tool) => {
      toast('ok', t('tools.manualCreated', { name: tool.name, state: enumLabel(t, TOOL_STATE_LABEL, tool.state) }));
      void invalidate('tools');
      onCreated(tool.id);
    },
  });
  return (
    <div className="stack" style={{ maxWidth: 960 }}>
      <p className="muted" style={{ margin: 0 }}>
        {rich(t, 'tools.manualIntro', { state: <b>{enumLabel(t, TOOL_STATE_LABEL, 'disabled')}</b> })}
      </p>
      <Field label={t('common.source')}>
        <select className="select" value={sourceId} onChange={(e) => setSourceId(e.target.value)} aria-label={t('common.source')}>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — {s.baseUrl}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('tools.definition')} hint={t('tools.definitionHint')}>
        <Editor value={spec} onChange={setSpec} height="380px" label={t('tools.definitionEditor')} />
      </Field>
      <ErrorBox error={create.error} />
      <div className="row">
        <button className="btn primary" onClick={() => create.mutate()} disabled={create.isPending || sources.length === 0}>
          {t('tools.createManual')}
        </button>
        {sources.length === 0 && (
          <button className="btn" onClick={() => navigate('/sources')}>
            {t('tools.registerSource')}
          </button>
        )}
        {!me.isAdmin && <span className="hint">{t('tools.ownersOwnTeam')}</span>}
      </div>
    </div>
  );
}

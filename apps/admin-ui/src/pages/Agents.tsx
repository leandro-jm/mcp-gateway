import { useMutation } from '@tanstack/react-query';
import { Lightbulb, Network, Repeat, Target } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api/client';
import { useSession } from '../api/session';
import type { AgentFinding, CompositeSuggestion, OutcomesView, ViewRange } from '../api/types';
import { BarChart, Graph } from '../components/charts';
import { useToast } from '../components/toast';
import { Badge, ErrorBox, fmtDate, fmtNumber, JsonView, PageHeader, Tabs } from '../components/ui';
import { useT, type T } from '../i18n';
import { useInvalidate, useTenantQuery } from '../lib/hooks';

type Tab = 'findings' | 'suggestions' | 'co-usage' | 'outcomes';
const TYPES: Array<{ id: AgentFinding['type']; label: Parameters<T>[0] }> = [
  { id: 'loop', label: 'agents.typeLoop' },
  { id: 'thrash', label: 'agents.typeThrash' },
  { id: 'search_miss', label: 'agents.typeSearchMiss' },
  { id: 'abandoned', label: 'agents.typeAbandoned' },
];

/** Agent insights (F15.24): bad patterns, composite suggestions, co-usage graph and outcomes. */
export function AgentsPage() {
  const t = useT();
  const { me } = useSession();
  const analyst = me.isAdmin || me.roles.includes('analytics-reader');
  const tabs = [
    ...(analyst ? [{ id: 'findings' as const, label: t('agents.tabFindings'), icon: <Repeat size={20} /> }] : []),
    { id: 'suggestions' as const, label: t('agents.tabSuggestions'), icon: <Lightbulb size={20} /> },
    ...(analyst
      ? [
          { id: 'co-usage' as const, label: t('agents.tabCoUsage'), icon: <Network size={20} /> },
          { id: 'outcomes' as const, label: t('agents.tabOutcomes'), icon: <Target size={20} /> },
        ]
      : []),
  ];
  const [tab, setTab] = useState<Tab>(tabs[0]!.id);
  const [range] = useState<ViewRange>('7d');
  return (
    <>
      <PageHeader title={t('agents.insightsTitle')} subtitle={t('agents.insightsSubtitle')} />
      <Tabs<Tab> tabs={tabs} value={tab} onChange={setTab} />
      <div className="content" data-testid={`agents-${tab}`}>
        {tab === 'findings' && <Findings range={range} />}
        {tab === 'suggestions' && <Suggestions />}
        {tab === 'co-usage' && <CoUsage range={range} />}
        {tab === 'outcomes' && <Outcomes range={range} />}
      </div>
    </>
  );
}

function Findings({ range }: { range: ViewRange }) {
  const t = useT();
  const [type, setType] = useState('');
  const q = useTenantQuery<{ items: AgentFinding[] }>(['agent-insights', 'findings', range, type], `/agent-insights/findings?last=${range}${type ? `&type=${type}` : ''}`);
  const label = (id: string) => t(TYPES.find((x) => x.id === id)?.label ?? 'agents.typeLoop');
  return (
    <>
      <div className="toolbar">
        <select className="select" style={{ width: 200 }} value={type} onChange={(e) => setType(e.target.value)} aria-label={t('agents.colType')}>
          <option value="">{t('agents.allTypes')}</option>
          {TYPES.map((x) => (
            <option key={x.id} value={x.id}>
              {t(x.label)}
            </option>
          ))}
        </select>
      </div>
      <ErrorBox error={q.error} />
      <table className="table">
        <thead>
          <tr>
            <th>{t('agents.colWhen')}</th>
            <th>{t('agents.colType')}</th>
            <th>{t('agents.colTool')}</th>
            <th>{t('agents.colCount')}</th>
            <th>{t('agents.colAgent')}</th>
            <th>{t('agents.colSubject')}</th>
            <th>{t('agents.colDetail')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(q.data?.items ?? []).map((f) => (
            <tr key={f.id}>
              <td className="muted">{fmtDate(f.at)}</td>
              <td>
                <Badge kind="warn">{label(f.type)}</Badge>
              </td>
              <td className="mono">{f.tool}</td>
              <td className="mono">{fmtNumber(f.count)}</td>
              <td className="mono muted">{f.agentName ?? '—'}</td>
              <td className="mono muted">{f.subject}</td>
              <td className="mono muted">{[f.detail, ...(f.related ?? [])].filter(Boolean).join(' · ') || '—'}</td>
              <td>
                <Link to={`/sessions?session=${f.sessionKey}`}>{t('agents.openSession')}</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {q.data && !q.data.items.length && <div className="muted" style={{ padding: 16 }}>{t('agents.noFindings')}</div>}
    </>
  );
}

function Suggestions() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const q = useTenantQuery<{ items: CompositeSuggestion[] }>(['agent-insights', 'suggestions'], '/agent-insights/suggestions?status=open');
  const accept = useMutation({
    mutationFn: (id: string) => api<{ compositeId: string }>(`/agent-insights/suggestions/${id}/accept`, { method: 'POST', body: {} }),
    onSuccess: (r) => {
      toast('ok', t('agents.accepted'));
      void invalidate('agent-insights');
      void invalidate('composites');
      navigate(`/composer?open=${r.compositeId}`);
    },
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => api(`/agent-insights/suggestions/${id}/dismiss`, { method: 'POST' }),
    onSuccess: () => void invalidate('agent-insights'),
  });
  return (
    <>
      <ErrorBox error={q.error ?? accept.error ?? dismiss.error} />
      {(q.data?.items ?? []).map((s) => (
        <div className="panel" key={s.id} data-testid="suggestion">
          <div className="panel-head">
            <span className="panel-title mono">{s.sequence.join(' → ')}</span>
          </div>
          <div className="panel-body stack">
            <span>{t('agents.suggestionLine', { sessions: s.sessions, subjects: s.subjects, share: fmtNumber(Math.round(s.share * 100)) })}</span>
            {s.draft && <JsonView value={s.draft} maxHeight={220} />}
            <div className="row">
              <button className="btn primary" onClick={() => accept.mutate(s.id)} disabled={accept.isPending || !s.draft}>
                {t('agents.accept')}
              </button>
              <button className="btn" onClick={() => navigate(`/composer?prompt=${encodeURIComponent(t('agents.refinePrompt', { sequence: s.sequence.join(' → ') }))}`)}>
                {t('agents.refineNl')}
              </button>
              <button className="btn ghost" onClick={() => dismiss.mutate(s.id)} disabled={dismiss.isPending}>
                {t('agents.dismiss')}
              </button>
            </div>
          </div>
        </div>
      ))}
      {q.data && !q.data.items.length && <div className="muted" style={{ padding: 16 }}>{t('agents.noSuggestions')}</div>}
    </>
  );
}

function CoUsage({ range }: { range: ViewRange }) {
  const t = useT();
  const q = useTenantQuery<{ nodes: string[]; edges: Array<{ from: string; to: string; count: number }> }>(['analytics', 'co-usage', range], `/analytics/co-usage?last=${range}`);
  if (!q.data) return <ErrorBox error={q.error} />;
  return <Graph title={t('agents.coUsageTitle')} nodes={q.data.nodes.slice(0, 30)} edges={q.data.edges.map((e) => ({ from: e.from, to: e.to, weight: e.count }))} />;
}

function Outcomes({ range }: { range: ViewRange }) {
  const t = useT();
  const q = useTenantQuery<OutcomesView>(['analytics', 'outcomes', range], `/analytics/outcomes?last=${range}`);
  const v = q.data;
  if (!v) return <ErrorBox error={q.error} />;
  if (!v.recent.length) return <div className="muted" style={{ padding: 16 }}>{t('agents.noOutcomes')}</div>;
  const pct = (n: number | null) => Math.round((n ?? 0) * 100);
  return (
    <>
      <div className="stat-grid">
        {Object.entries(v.totals).map(([k, n]) => (
          <div key={k} className="stat-card">
            <div className="stat-label">{k}</div>
            <div className="stat-value">{fmtNumber(n)}</div>
          </div>
        ))}
      </div>
      <div className="chart-grid-2">
        <BarChart title={t('agents.successByTool')} color={2} format={(n) => `${n}%`} data={v.byTool.map((x) => ({ label: x.tool, value: pct(x.successRate) }))} />
        <BarChart title={t('agents.successByServer')} color={2} format={(n) => `${n}%`} data={v.byVirtualServer.filter((x) => x.virtualServer).map((x) => ({ label: x.virtualServer!, value: pct(x.successRate) }))} />
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>{t('agents.colWhen')}</th>
            <th>{t('agents.colOutcome')}</th>
            <th>{t('agents.colReason')}</th>
            <th>{t('agents.colAgent')}</th>
            <th>{t('agents.colTools')}</th>
          </tr>
        </thead>
        <tbody>
          {v.recent.map((o, i) => (
            <tr key={i}>
              <td className="muted">{fmtDate(o.ts)}</td>
              <td>
                <Badge kind={o.outcome === 'success' ? 'ok' : o.outcome === 'failure' ? 'error' : 'warn'}>{o.outcome}</Badge>
              </td>
              <td className="mono muted">{o.reasonCode ?? '—'}</td>
              <td className="mono muted">{o.agentName ?? '—'}</td>
              <td className="mono">{o.tools.join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

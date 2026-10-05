import { formatNumber } from '@mcp-gateway/i18n';
import { useMutation } from '@tanstack/react-query';
import { Activity, Boxes, Coins, ShieldAlert } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api/client';
import { useSession } from '../api/session';
import type { FinopsView, SecurityView, SreView, SubjectAccessReport, ToolsView, ViewRange } from '../api/types';
import { BarChart, LineChart, StackedBar, StatCard } from '../components/charts';
import { Badge, CodeBlock, ErrorBox, fmtDate, fmtNumber, PageHeader, Tabs } from '../components/ui';
import { getLocale, useT, type T } from '../i18n';
import { useTenantQuery } from '../lib/hooks';

type Tab = 'sre' | 'tools' | 'security' | 'finops';

const RANGES: Array<{ id: ViewRange; label: Parameters<T>[0] }> = [
  { id: '1h', label: 'observability.range1h' },
  { id: '24h', label: 'observability.range24h' },
  { id: '7d', label: 'observability.range7d' },
  { id: '30d', label: 'observability.range30d' },
];

const ms = (v: number | null | undefined) => (v == null ? '—' : `${fmtNumber(Math.round(v))} ms`);
const pct = (v: number | null | undefined) => (v == null ? '—' : formatNumber(getLocale(), v, { style: 'percent', maximumFractionDigits: 1 }));
const money = (v: number, currency: string) => formatNumber(getLocale(), v, { style: 'currency', currency });
const hourLabel = (iso: string) => new Date(iso).toLocaleString(getLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Observability (F15.16): one tab per audience. Tool owners only see the Tools tab, filtered to their tools. */
export function ObservabilityPage() {
  const t = useT();
  const { me } = useSession();
  const analyst = me.isAdmin || me.roles.includes('analytics-reader');
  const tabs: Array<{ id: Tab; label: string; icon: ReactNode }> = analyst
    ? [
        { id: 'sre', label: t('observability.tabSre'), icon: <Activity size={20} /> },
        { id: 'tools', label: t('observability.tabTools'), icon: <Boxes size={20} /> },
        { id: 'security', label: t('observability.tabSecurity'), icon: <ShieldAlert size={20} /> },
        { id: 'finops', label: t('observability.tabFinops'), icon: <Coins size={20} /> },
      ]
    : [{ id: 'tools', label: t('observability.tabTools'), icon: <Boxes size={20} /> }];
  const [tab, setTab] = useState<Tab>(tabs[0]!.id);
  const [range, setRange] = useState<ViewRange>('7d');
  return (
    <>
      <PageHeader
        title={t('observability.title')}
        subtitle={t('observability.subtitle')}
        right={
          <select className="select" style={{ width: 190 }} value={range} onChange={(e) => setRange(e.target.value as ViewRange)} aria-label={t('observability.range')}>
            {RANGES.map((r) => (
              <option key={r.id} value={r.id}>
                {t(r.label)}
              </option>
            ))}
          </select>
        }
      />
      <Tabs<Tab> tabs={tabs} value={tab} onChange={setTab} />
      <div className="content" data-testid={`observability-${tab}`}>
        {tab === 'sre' && <SreTab range={range} />}
        {tab === 'tools' && <ToolsTab range={range} />}
        {tab === 'security' && <SecurityTab range={range} admin={me.isAdmin} />}
        {tab === 'finops' && <FinopsTab range={range} />}
        {analyst && <ConnectCard />}
      </div>
    </>
  );
}

function SreTab({ range }: { range: ViewRange }) {
  const t = useT();
  const q = useTenantQuery<SreView>(['analytics', 'sre', range], `/analytics/sre?last=${range}`);
  const v = q.data;
  if (!v) return <ErrorBox error={q.error} />;
  const stageNames = ['authz', 'validation', 'pii', 'upstream', 'projection', 'artifact'];
  return (
    <>
      <div className="stat-grid">
        <StatCard label={t('observability.statCalls')} value={fmtNumber(v.totals.calls)} trend={v.overTime.map((p) => p.calls)} />
        <StatCard label={t('observability.statErrorRate')} value={pct(v.totals.errorRate)} tone={(v.totals.errorRate ?? 0) > 0.05 ? 'bad' : undefined} />
        <StatCard label={t('observability.statLatencyP95')} value={ms(v.totals.latencyP95)} />
        <StatCard label={t('observability.statOverheadP95')} value={ms(v.totals.overheadP95)} hint={t('observability.statOverheadHint')} />
        <StatCard label={t('observability.statUpstreamAvg')} value={ms(v.totals.upstreamAvg)} />
      </div>
      <div className="chart-grid-2">
        <LineChart
          title={t('observability.chartOverTime')}
          formatX={hourLabel}
          formatY={(n) => `${Math.round(n)}`}
          series={[
            { name: t('observability.seriesLatency'), points: v.overTime.map((p) => ({ x: p.ts, y: p.latencyP95 })) },
            { name: t('observability.seriesOverhead'), points: v.overTime.map((p) => ({ x: p.ts, y: p.overheadP95 })) },
            { name: t('observability.seriesUpstream'), points: v.overTime.map((p) => ({ x: p.ts, y: p.upstreamAvg })) },
          ]}
        />
        <StackedBar
          title={t('observability.chartStages')}
          format={ms}
          segments={stageNames.filter((s) => (v.stages[s] ?? 0) > 0).map((s) => ({ label: s, value: v.stages[s] ?? 0 }))}
        />
        <BarChart title={t('observability.chartErrorsBySource')} color={4} data={v.errorsBySource.map((e) => ({ label: e.source ?? t('observability.unknown'), value: e.calls }))} />
        <BarChart title={t('observability.chartErrorsByStage')} color={4} data={v.errorsByStage.map((e) => ({ label: e.stage ?? t('observability.unknown'), value: e.calls }))} />
        <BarChart title={t('observability.circuitOpen')} color={4} data={v.circuitOpen.map((e) => ({ label: e.source ?? t('observability.unknown'), value: e.calls }))} />
      </div>
    </>
  );
}

function ToolsTab({ range }: { range: ViewRange }) {
  const t = useT();
  const q = useTenantQuery<ToolsView>(['analytics', 'tools', range], `/analytics/tools?last=${range}`);
  const v = q.data;
  if (!v) return <ErrorBox error={q.error} />;
  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">{t('observability.usageTitle')}</span>
        </div>
        <table className="table" data-testid="tools-usage">
          <thead>
            <tr>
              <th>{t('observability.colTool')}</th>
              <th>{t('observability.colCalls')}</th>
              <th>{t('observability.colErrors')}</th>
              <th>{t('observability.colAgents')}</th>
              <th>{t('observability.colRetries')}</th>
              <th>{t('observability.colValidation')}</th>
            </tr>
          </thead>
          <tbody>
            {v.usage.map((u) => (
              <tr key={u.tool}>
                <td className="mono">{u.tool}</td>
                <td className="mono">{fmtNumber(u.calls)}</td>
                <td className="mono">{fmtNumber(u.errors)}</td>
                <td className="mono">{fmtNumber(u.agents)}</td>
                <td className="mono">{fmtNumber(u.retries)}</td>
                <td className="mono">{fmtNumber(u.validationErrors)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="chart-grid-2" style={{ marginTop: 16 }}>
        <BarChart title={t('observability.byAgentTitle')} data={v.byAgent.map((b) => ({ label: `${b.tool ?? '—'} · ${b.agent ?? t('observability.unknown')}`, value: b.calls }))} />
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">{t('observability.neverUsedTitle')}</span>
          </div>
          <div className="panel-body stack">
            <span className="hint">{t('observability.neverUsedHint')}</span>
            {v.neverUsed.length ? (
              <div className="chips">
                {v.neverUsed.map((n) => (
                  <Badge key={n.tool}>{n.tool}</Badge>
                ))}
              </div>
            ) : (
              <span className="muted">{t('observability.neverUsedNone')}</span>
            )}
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">{t('observability.driftTitle')}</span>
        </div>
        {v.driftImpact.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('observability.colTool')}</th>
                <th>{t('observability.colDriftKind')}</th>
                <th>{t('observability.colWhen')}</th>
                <th>{t('observability.colBefore')}</th>
                <th>{t('observability.colAfter')}</th>
              </tr>
            </thead>
            <tbody>
              {v.driftImpact.map((d) => (
                <tr key={`${d.tool}-${d.at}`}>
                  <td className="mono">{d.tool}</td>
                  <td>{d.kind}</td>
                  <td className="muted">{fmtDate(d.at)}</td>
                  <td className="mono">{pct(d.errorRateBefore)}</td>
                  <td className="mono">{pct(d.errorRateAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="panel-body muted">{t('observability.driftNone')}</div>
        )}
      </div>
    </>
  );
}

function SecurityTab({ range, admin }: { range: ViewRange; admin: boolean }) {
  const t = useT();
  const q = useTenantQuery<SecurityView>(['analytics', 'security', range], `/analytics/security?last=${range}`);
  const v = q.data;
  if (!v) return <ErrorBox error={q.error} />;
  return (
    <>
      <div className="chart-grid-2">
        <BarChart title={t('observability.chartDenials')} color={4} data={v.denials.map((d) => ({ label: d.tool ?? '—', value: d.calls }))} />
        <BarChart title={t('observability.chartRedactions')} color={1} data={Object.entries(v.redactionsByDetector).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }))} />
      </div>
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">{t('observability.denialsByRule')}</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>{t('observability.colRule')}</th>
              <th>{t('observability.colReason')}</th>
              <th>{t('observability.colTool')}</th>
              <th>{t('observability.colCalls')}</th>
            </tr>
          </thead>
          <tbody>
            {v.denialsByRule.map((d) => (
              <tr key={`${d.ruleId}-${d.tool}-${d.reason}`}>
                <td className="mono muted">{d.ruleId ?? '—'}</td>
                <td>{d.reason ?? '—'}</td>
                <td className="mono">{d.tool}</td>
                <td className="mono">{fmtNumber(d.calls)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">{t('observability.anomaliesTitle')}</span>
        </div>
        {v.anomalies.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('observability.colKey')}</th>
                <th>{t('observability.colDimension')}</th>
                <th>{t('observability.colCalls')}</th>
                <th>{t('observability.colBaseline')}</th>
                <th>{t('observability.colScore')}</th>
              </tr>
            </thead>
            <tbody>
              {v.anomalies.map((a) => (
                <tr key={`${a.dimension}-${a.key}`}>
                  <td className="mono">{a.key}</td>
                  <td>{a.dimension}</td>
                  <td className="mono">{fmtNumber(a.calls)}</td>
                  <td className="mono">{fmtNumber(a.baseline)}</td>
                  <td className="mono">{fmtNumber(a.score)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="panel-body muted">{t('observability.anomaliesNone')}</div>
        )}
      </div>
      {admin && <LgpdPanel />}
    </>
  );
}

const DETECTORS = ['cpf', 'cnpj', 'pis', 'email', 'telefone'];

function LgpdPanel() {
  const t = useT();
  const [detector, setDetector] = useState('cpf');
  const [value, setValue] = useState('');
  const search = useMutation({ mutationFn: () => api<SubjectAccessReport>('/lgpd/subject-access', { method: 'POST', body: { detector, value } }) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) search.mutate();
  };
  const r = search.data;
  return (
    <div className="panel" data-testid="lgpd-panel">
      <div className="panel-head">
        <span className="panel-title">{t('observability.lgpdTitle')}</span>
      </div>
      <div className="panel-body stack">
        <span className="hint">{t('observability.lgpdHint')}</span>
        <form className="toolbar" onSubmit={submit}>
          <select className="select" style={{ width: 150 }} value={detector} onChange={(e) => setDetector(e.target.value)} aria-label={t('observability.lgpdDetector')}>
            {DETECTORS.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
          <input className="input mono" style={{ width: 280 }} autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} aria-label={t('observability.lgpdValue')} placeholder={t('observability.lgpdValue')} />
          <button className="btn primary" type="submit" disabled={search.isPending || !value.trim()}>
            {t('observability.lgpdSearch')}
          </button>
        </form>
        <ErrorBox error={search.error} />
        {r && (
          <>
            <strong>{t('observability.lgpdTotal', { count: r.total })}</strong>
            <div className="grid-2">
              {(['subjects', 'agents', 'clients', 'tools'] as const).map((k) => (
                <div key={k}>
                  <div className="label">{t(`observability.lgpd${k[0]!.toUpperCase()}${k.slice(1)}` as Parameters<T>[0])}</div>
                  <div className="chips">
                    {r.summary[k].map((s) => (
                      <Badge key={String(s.value)}>
                        {s.value ?? t('observability.unknown')} · {s.calls}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {r.matches.length > 0 && <AccessTable rows={r.matches} />}
            {r.possibleMatches.length > 0 && (
              <>
                <div className="label">{t('observability.lgpdPossible')}</div>
                <AccessTable rows={r.possibleMatches} />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AccessTable({ rows }: { rows: SubjectAccessReport['matches'] }) {
  const t = useT();
  return (
    <table className="table">
      <thead>
        <tr>
          <th>{t('observability.colWhen')}</th>
          <th>{t('observability.colTool')}</th>
          <th>{t('observability.colSubject')}</th>
          <th>{t('observability.colAgent')}</th>
          <th>{t('observability.colClient')}</th>
          <th>{t('observability.colDirection')}</th>
          <th>{t('observability.colDecision')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => (
          <tr key={`${m.callId}-${m.direction}`}>
            <td className="muted">{fmtDate(m.ts)}</td>
            <td className="mono">{m.tool}</td>
            <td className="mono">{m.subject}</td>
            <td className="mono">{m.agentName ?? '—'}</td>
            <td className="mono">{m.clientId ?? '—'}</td>
            <td>{m.direction === 'request' ? t('observability.directionRequest') : t('observability.directionResponse')}</td>
            <td>
              <Badge kind={m.decision}>{m.decision}</Badge>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FinopsTab({ range }: { range: ViewRange }) {
  const t = useT();
  const q = useTenantQuery<FinopsView>(['analytics', 'finops', range], `/analytics/finops?last=${range}`);
  const v = q.data;
  if (!v) return <ErrorBox error={q.error} />;
  const tokens = (n: number) => t('observability.tokens', { count: fmtNumber(n) });
  return (
    <>
      <div className="stat-grid" data-testid="before-after">
        <StatCard label={t('observability.cardWithout')} value={tokens(v.beforeAfter.withoutGateway)} />
        <StatCard label={t('observability.cardWith')} value={tokens(v.beforeAfter.withGateway)} />
        <StatCard label={t('observability.cardSaved')} value={`${fmtNumber(v.beforeAfter.savedPct)}%`} tone="good" />
        <StatCard label={t('observability.cardMoney')} value={money(v.beforeAfter.moneySaved, v.pricing.currency)} tone="good" hint={t('observability.estimateNote')} />
      </div>
      <div className="chart-grid-2">
        <BarChart
          title={t('observability.chartSavedByMechanism')}
          color={2}
          format={fmtNumber}
          data={[
            { label: t('observability.mechProjection'), value: v.tokens.savedByMechanism.projection },
            { label: t('observability.mechArtifact'), value: v.tokens.savedByMechanism.artifact },
            { label: t('observability.mechOmni'), value: v.tokens.savedByMechanism.omni },
          ]}
        />
        <UsageTable title={t('observability.usageByClient')} rows={v.usageByClient} />
        <UsageTable title={t('observability.usageByAgent')} rows={v.usageByAgent} />
        <UsageTable title={t('observability.usageBySubject')} rows={v.usageBySubject} />
      </div>
    </>
  );
}

function UsageTable({ title, rows }: { title: string; rows: FinopsView['usageByClient'] }) {
  const t = useT();
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">{title}</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>{t('observability.colKey')}</th>
            <th>{t('observability.colCalls')}</th>
            <th>{t('observability.colErrors')}</th>
            <th>{t('observability.colTokens')}</th>
            <th>{t('observability.colSaved')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r.key)}>
              <td className="mono">{r.key ?? t('observability.unknown')}</td>
              <td className="mono">{fmtNumber(r.calls)}</td>
              <td className="mono">{fmtNumber(r.errors)}</td>
              <td className="mono">{fmtNumber(r.responseTokens)}</td>
              <td className="mono">{fmtNumber(r.tokensSaved)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConnectCard() {
  const t = useT();
  const url = `${window.location.origin}/mcp/observability`;
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="panel-head">
        <span className="panel-title">{t('observability.connectTitle')}</span>
      </div>
      <div className="panel-body stack">
        <span>{t('observability.connectText')}</span>
        <CodeBlock highlightFirstWord code={`claude mcp add --transport http mcp-gateway-observability ${url} --header "Authorization: Bearer $TOKEN"`} />
        <span className="hint">{t('observability.connectRole')}</span>
      </div>
    </div>
  );
}

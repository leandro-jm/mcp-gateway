import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { CallSummary, SessionSummary, Trajectory, ViewRange } from '../api/types';
import { Swimlane } from '../components/charts';
import { Pagination } from '../components/Pagination';
import { ChartSkeleton, SkeletonRows } from '../components/Skeleton';
import { Badge, ErrorBox, fmtDate, fmtNumber, PageHeader } from '../components/ui';
import { useT, type T } from '../i18n';
import { timeLabel } from '../lib/format';
import { DECISION_LABEL, enumLabel } from '../lib/labels';
import { useTenantQuery } from '../lib/hooks';
import { usePagination } from '../lib/pagination';

const RANGES: Array<{ id: ViewRange; label: Parameters<T>[0] }> = [
  { id: '24h', label: 'observability.range24h' },
  { id: '7d', label: 'observability.range7d' },
  { id: '30d', label: 'observability.range30d' },
];

const DECISION_TONE = [
  { id: 'allow', tone: 'success' },
  { id: 'deny', tone: 'warning' },
  { id: 'error', tone: 'danger' },
] as const;

/** Sessions (F15.24): one row per agent session; the trajectory replays it call by call. */
export function SessionsPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const [range, setRange] = useState<ViewRange>('24h');
  const sessions = useTenantQuery<{ items: SessionSummary[] }>(['sessions', range], `/sessions?last=${range}`);
  const open = params.get('session');
  const items = sessions.data?.items ?? [];
  const { rows, pager } = usePagination(items, { reset: range });
  // a link to `?session=` opens the page that holds that row, once per session and range
  const openIndex = open ? items.findIndex((s) => s.sessionKey === open) : -1;
  const target = openIndex >= 0 ? `${range}:${open}` : null;
  const [jumped, setJumped] = useState<string | null>(null);
  if (target && target !== jumped) {
    setJumped(target);
    pager.onPage(Math.floor(openIndex / pager.pageSize));
  }
  return (
    <>
      <PageHeader
        title={t('agents.sessionsTitle')}
        subtitle={t('agents.sessionsSubtitle')}
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
      <div className="content">
        <ErrorBox error={sessions.error} />
        {open && <TrajectoryView sessionKey={open} range={range} />}
        <table className="table" data-testid="sessions-table" aria-busy={sessions.isLoading}>
          <thead>
            <tr>
              <th>{t('agents.colStart')}</th>
              <th>{t('agents.colEnd')}</th>
              <th>{t('agents.colAgent')}</th>
              <th>{t('agents.colSubject')}</th>
              <th>{t('agents.colEndpoint')}</th>
              <th>{t('agents.colCalls')}</th>
              <th>{t('agents.colErrors')}</th>
              <th>{t('agents.colTools')}</th>
            </tr>
          </thead>
          <tbody>
            {sessions.isLoading && <SkeletonRows cols={8} />}
            {rows.map((s) => (
              <tr key={s.sessionKey} className={`clickable ${open === s.sessionKey ? 'selected' : ''}`} onClick={() => setParams({ session: s.sessionKey })}>
                <td className="muted nowrap">{fmtDate(s.start)}</td>
                <td className="muted nowrap">{fmtDate(s.end)}</td>
                <td className="mono">{s.agentName ?? '—'}</td>
                <td className="mono muted">{s.subject}</td>
                <td className="mono muted">{s.endpoint}</td>
                <td className="mono">{fmtNumber(s.calls)}</td>
                <td className="mono">{fmtNumber(s.errors)}</td>
                <td className="mono">{fmtNumber(s.tools)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination {...pager} />
        {sessions.data && !sessions.data.items.length && <div className="muted" style={{ padding: 16 }}>{t('agents.noSessions')}</div>}
      </div>
    </>
  );
}

function TrajectoryView({ sessionKey, range }: { sessionKey: string; range: ViewRange }) {
  const t = useT();
  const q = useTenantQuery<Trajectory>(['sessions', sessionKey, range], `/sessions/${sessionKey}?last=${range}`);
  const events = useMemo(() => q.data?.segments.flatMap((s) => s.events) ?? [], [q.data]);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => setStep(0), [sessionKey]);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setStep((s) => (s + 1 < events.length ? s + 1 : (setPlaying(false), s))), 900);
    return () => clearInterval(id);
  }, [playing, events.length]);
  if (!q.data) return q.isLoading ? <ChartSkeleton height={200} /> : <ErrorBox error={q.error} />;
  const current = events[step];
  const flagged = new Set(q.data.findings.flatMap((f) => [f.firstCallId]));
  return (
    <div className="panel" data-testid="trajectory">
      <div className="panel-head">
        <span className="panel-title">{t('agents.timeline')}</span>
        <span className="spacer" />
        <span className="muted">{t('agents.step', { current: events.length ? step + 1 : 0, total: events.length })}</span>
        <button className="icon-btn" onClick={() => setStep((s) => Math.max(0, s - 1))} aria-label={t('agents.prev')}>
          <ChevronLeft size={16} />
        </button>
        <button className="icon-btn" onClick={() => setPlaying((p) => !p)} aria-label={playing ? t('agents.pause') : t('agents.play')}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button className="icon-btn" onClick={() => setStep((s) => Math.min(events.length - 1, s + 1))} aria-label={t('agents.next')}>
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="panel-body stack">
        <Swimlane
          title={t('agents.timelineByTool')}
          laneLabel={t('agents.colTool')}
          groupLabel={t('observability.colDecision')}
          current={step}
          onPick={setStep}
          groups={DECISION_TONE.map((d) => ({ ...d, label: enumLabel(t, DECISION_LABEL, d.id) }))}
          points={events.map((e) => ({
            lane: e.tool.name,
            group: e.decision,
            flagged: flagged.has(e.callId),
            tip: `${enumLabel(t, DECISION_LABEL, e.decision)} · ${fmtNumber(e.latencyMs)} ms · ${timeLabel(e.ts)}`,
          }))}
        />
        {current && <StepDetail e={current} />}
        {q.data.findings.length > 0 && (
          <>
            <div className="label">{t('agents.findingsInSession')}</div>
            <div className="chips">
              {q.data.findings.map((f) => (
                <Badge key={f.id} kind="warn">
                  {f.type} · {f.tool} · {f.count}
                </Badge>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StepDetail({ e }: { e: CallSummary }) {
  const t = useT();
  return (
    <dl className="kv">
      <dt>{t('agents.colTool')}</dt>
      <dd className="mono">
        {e.tool.name} <Badge kind={e.decision}>{enumLabel(t, DECISION_LABEL, e.decision)}</Badge>
      </dd>
      <dt>{t('agents.colWhen')}</dt>
      <dd>{timeLabel(e.ts)}</dd>
      <dt>{t('calls.colLatency')}</dt>
      <dd className="mono">{fmtNumber(e.latencyMs)} ms</dd>
      {e.error && (
        <>
          <dt>{t('calls.colError')}</dt>
          <dd className="mono">
            {e.error.code} ({e.error.stage ?? '—'})
          </dd>
        </>
      )}
      <dt />
      <dd>
        <Link to={`/calls?open=${e.callId}`}>{t('calls.explain')}</Link>
      </dd>
    </dl>
  );
}

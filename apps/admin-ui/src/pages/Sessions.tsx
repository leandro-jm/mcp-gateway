import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { CallSummary, SessionSummary, Trajectory, ViewRange } from '../api/types';
import { Badge, ErrorBox, fmtDate, fmtNumber, PageHeader } from '../components/ui';
import { getLocale, useT, type T } from '../i18n';
import { DECISION_LABEL, enumLabel } from '../lib/labels';
import { useTenantQuery } from '../lib/hooks';

const RANGES: Array<{ id: ViewRange; label: Parameters<T>[0] }> = [
  { id: '24h', label: 'observability.range24h' },
  { id: '7d', label: 'observability.range7d' },
  { id: '30d', label: 'observability.range30d' },
];

const DECISION_COLOR: Record<string, string> = { allow: 'var(--success)', deny: 'var(--warning)', error: 'var(--danger)' };

/** Sessions (F15.24): one row per agent session; the trajectory replays it call by call. */
export function SessionsPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const [range, setRange] = useState<ViewRange>('24h');
  const sessions = useTenantQuery<{ items: SessionSummary[] }>(['sessions', range], `/sessions?last=${range}`);
  const open = params.get('session');
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
        <table className="table" data-testid="sessions-table">
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
            {(sessions.data?.items ?? []).map((s) => (
              <tr key={s.sessionKey} className={`clickable ${open === s.sessionKey ? 'selected' : ''}`} onClick={() => setParams({ session: s.sessionKey })}>
                <td className="muted">{fmtDate(s.start)}</td>
                <td className="muted">{fmtDate(s.end)}</td>
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
  if (!q.data) return <ErrorBox error={q.error} />;
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
        <Swimlane events={events} current={step} flagged={flagged} onPick={setStep} />
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

/** One lane per tool, calls placed in order; color = decision, ring = current step. */
function Swimlane({ events, current, flagged, onPick }: { events: CallSummary[]; current: number; flagged: Set<string>; onPick(i: number): void }) {
  const lanes = [...new Set(events.map((e) => e.tool.name))];
  const W = 900;
  const laneH = 26;
  const left = 200;
  const H = lanes.length * laneH + 10;
  const x = (i: number) => left + (events.length <= 1 ? (W - left) / 2 : (i / (events.length - 1)) * (W - left - 16));
  return (
    <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="timeline">
      {lanes.map((l, i) => (
        <g key={l}>
          <line x1={left} x2={W} y1={i * laneH + laneH / 2} y2={i * laneH + laneH / 2} className="chart-grid" />
          <text x={left - 8} y={i * laneH + laneH / 2 + 4} textAnchor="end" className="chart-label">
            {l.length > 28 ? `${l.slice(0, 27)}…` : l}
          </text>
        </g>
      ))}
      {events.map((e, i) => {
        const y = lanes.indexOf(e.tool.name) * laneH + laneH / 2;
        return (
          <g key={e.callId} onClick={() => onPick(i)} style={{ cursor: 'pointer' }}>
            {i === current && <circle cx={x(i)} cy={y} r={9} fill="none" stroke="var(--accent)" strokeWidth={2} />}
            <circle cx={x(i)} cy={y} r={flagged.has(e.callId) ? 6 : 5} fill={DECISION_COLOR[e.decision] ?? 'var(--text-2)'}>
              <title>{`${i + 1}. ${e.tool.name} · ${e.decision} · ${e.latencyMs} ms`}</title>
            </circle>
          </g>
        );
      })}
    </svg>
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
      <dd>{new Date(e.ts).toLocaleTimeString(getLocale())}</dd>
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

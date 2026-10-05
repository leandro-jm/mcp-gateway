import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { Bug, ExternalLink, ListTree, RotateCcw } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { api } from '../api/client';
import { useSession } from '../api/session';
import type { CallExplanation, CallSummary, CapturedCall, DebugCapture, ReplayResult } from '../api/types';
import { StackedBar } from '../components/charts';
import { DiffView } from '../components/DiffView';
import { useToast } from '../components/toast';
import { Badge, Drawer, ErrorBox, Field, fmtBytes, fmtDate, fmtNumber, JsonView, PageHeader, Tabs } from '../components/ui';
import { useT } from '../i18n';
import { DECISION_LABEL, enumLabel } from '../lib/labels';
import { useInvalidate, useTenantQuery } from '../lib/hooks';

type Tab = 'calls' | 'captures';
const KINDS = ['tool', 'composite_step', 'meta', 'list', 'artifact'];
const DECISIONS = ['allow', 'deny', 'error'];

/** Call explorer (F15.19): filters, explanation drawer, raw × final and replay for admins. */
export function CallsPage() {
  const t = useT();
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>('calls');
  const open = params.get('open');
  const tabs = [
    { id: 'calls' as const, label: t('calls.tabCalls'), icon: <ListTree size={20} /> },
    ...(me.isAdmin ? [{ id: 'captures' as const, label: t('calls.tabCaptures'), icon: <Bug size={20} /> }] : []),
  ];
  return (
    <>
      <PageHeader title={t('calls.title')} subtitle={t('calls.subtitle')} />
      <Tabs<Tab> tabs={tabs} value={tab} onChange={setTab} />
      <div className="content">{tab === 'calls' ? <CallList onOpen={(id) => setParams({ open: id })} /> : <Captures />}</div>
      {open && <CallDrawer callId={open} admin={me.isAdmin} onClose={() => setParams({})} onOpen={(id) => setParams({ open: id })} />}
    </>
  );
}

function CallList({ onOpen }: { onOpen(id: string): void }) {
  const t = useT();
  const { tenant } = useSession();
  const [f, setF] = useState({ tool: '', decision: '', kind: 'tool', agent: '', session: '' });
  const qs = new URLSearchParams({ limit: '50' });
  for (const [k, v] of Object.entries(f)) if (v) qs.set(k, v);
  const q = useInfiniteQuery({
    queryKey: [tenant, 'calls', qs.toString()],
    queryFn: ({ pageParam }) => api<{ items: CallSummary[]; nextCursor: string | null }>(`/calls?${qs}${pageParam ? `&cursor=${pageParam}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <>
      <div className="toolbar">
        <input className="input" style={{ width: 220 }} placeholder={t('calls.toolPlaceholder')} aria-label={t('calls.toolPlaceholder')} value={f.tool} onChange={set('tool')} />
        <select className="select" style={{ width: 170 }} value={f.decision} onChange={set('decision')} aria-label={t('common.decision')}>
          <option value="">{t('calls.allDecisions')}</option>
          {DECISIONS.map((d) => (
            <option key={d} value={d}>
              {enumLabel(t, DECISION_LABEL, d)}
            </option>
          ))}
        </select>
        <select className="select" style={{ width: 170 }} value={f.kind} onChange={set('kind')} aria-label="kind">
          <option value="">{t('calls.allKinds')}</option>
          {KINDS.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <input className="input" style={{ width: 160 }} placeholder={t('calls.agentPlaceholder')} aria-label={t('calls.agentPlaceholder')} value={f.agent} onChange={set('agent')} />
        <input className="input mono" style={{ width: 200 }} placeholder={t('calls.sessionPlaceholder')} aria-label={t('calls.sessionPlaceholder')} value={f.session} onChange={set('session')} />
      </div>
      <ErrorBox error={q.error} />
      <table className="table" data-testid="calls-table">
        <thead>
          <tr>
            <th>{t('common.when')}</th>
            <th>{t('common.tool')}</th>
            <th>{t('common.decision')}</th>
            <th>{t('common.subject')}</th>
            <th>{t('calls.colAgent')}</th>
            <th>{t('calls.colLatency')}</th>
            <th>{t('calls.colOverhead')}</th>
            <th>{t('calls.colError')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.callId} className="clickable" onClick={() => onOpen(c.callId)}>
              <td className="muted">{fmtDate(c.ts)}</td>
              <td className="mono">{c.tool.name}</td>
              <td>
                <Badge kind={c.decision}>{enumLabel(t, DECISION_LABEL, c.decision)}</Badge>
              </td>
              <td className="mono muted">{c.subject}</td>
              <td className="mono muted">{c.agentName ?? '—'}</td>
              <td className="mono">{fmtNumber(c.latencyMs)} ms</td>
              <td className="mono">{c.overheadMs != null ? `${fmtNumber(c.overheadMs)} ms` : '—'}</td>
              <td className="mono muted">{c.error ? `${c.error.code} (${c.error.stage ?? '—'})` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && !q.isLoading && <div className="muted" style={{ padding: 16 }}>{t('calls.none')}</div>}
      {q.hasNextPage && (
        <button className="btn" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage} style={{ marginTop: 12 }}>
          {t('calls.loadMore')}
        </button>
      )}
    </>
  );
}

function CallDrawer({ callId, admin, onClose, onOpen }: { callId: string; admin: boolean; onClose(): void; onOpen(id: string): void }) {
  const t = useT();
  const q = useTenantQuery<CallExplanation>(['calls', callId], `/calls/${callId}`);
  const e = q.data;
  return (
    <Drawer
      title={e?.call.tool.name ?? callId}
      subtitle={e && <Badge kind={e.call.decision}>{enumLabel(t, DECISION_LABEL, e.call.decision)}</Badge>}
      actions={
        e?.traceUrl ? (
          <a className="btn sm ghost" href={e.traceUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={14} /> {t('calls.openTrace')}
          </a>
        ) : undefined
      }
      onClose={onClose}
    >
      <div className="drawer-body stack" data-testid="call-explain">
        <ErrorBox error={q.error} />
        {e && (
          <>
            <StackedBar title={t('calls.waterfall')} format={(v) => `${fmtNumber(v)} ms`} segments={e.stages.filter((s) => s.ms > 0).map((s) => ({ label: s.stage, value: s.ms }))} />
            <div className="panel">
              <div className="panel-head">
                <span className="panel-title">{t('calls.policy')}</span>
              </div>
              <div className="panel-body stack">
                <dl className="kv">
                  <dt>{t('calls.rule')}</dt>
                  <dd className="mono">{e.policy.ruleId ?? '—'}</dd>
                  <dt>{t('calls.reason')}</dt>
                  <dd className="mono">{e.policy.reason ?? '—'}</dd>
                </dl>
                {e.policy.policyChanged === true && e.policy.current && (
                  <div className="alert warn">{t('calls.policyChanged', { effect: e.policy.current.effect, reason: e.policy.current.reason })}</div>
                )}
                {e.policy.policyChanged === false && <span className="hint">{t('calls.policyStill')}</span>}
                {e.policy.policyChanged === null && <span className="hint">{t('calls.policyUnknown')}</span>}
                {e.policy.trace && (
                  <>
                    <div className="label">{t('calls.trace')}</div>
                    <JsonView value={e.policy.trace} maxHeight={200} />
                  </>
                )}
              </div>
            </div>
            <div className="panel">
              <div className="panel-head">
                <span className="panel-title">{t('calls.data')}</span>
              </div>
              <div className="panel-body stack">
                <div className="chips">
                  <span className="label">{t('calls.redactions')}</span>
                  {Object.entries(e.data.redactionsByDetector).map(([d, n]) => (
                    <Badge key={d}>
                      {d} · {n}
                    </Badge>
                  ))}
                  {!Object.keys(e.data.redactionsByDetector).length && <span className="muted">0</span>}
                </div>
                <span>{e.data.projection ? t('calls.projectionCut', { pct: fmtNumber(e.data.projection.cutPct), bytes: fmtBytes(e.data.projection.cutBytes) }) : t('calls.noProjection')}</span>
                {e.data.artifact && <span>{t('calls.artifact', { bytes: fmtBytes(e.data.artifact.bytes) })}</span>}
                <span>
                  {t('calls.tokens')}:{' '}
                  <span className="mono">
                    {t('calls.tokensLine', {
                      definition: fmtNumber(e.tokens.definition ?? 0),
                      response: fmtNumber(e.tokens.response ?? 0),
                      saved: fmtNumber(e.tokens.savedProjection + e.tokens.savedArtifact),
                    })}
                  </span>
                </span>
              </div>
            </div>
            {e.children.length > 0 && (
              <div className="panel">
                <div className="panel-head">
                  <span className="panel-title">{t('calls.steps')}</span>
                </div>
                <table className="table">
                  <tbody>
                    {e.children.map((c) => (
                      <tr key={c.callId} className="clickable" onClick={() => onOpen(c.callId)}>
                        <td className="mono">{c.tool.name}</td>
                        <td>
                          <Badge kind={c.decision}>{enumLabel(t, DECISION_LABEL, c.decision)}</Badge>
                        </td>
                        <td className="mono">{fmtNumber(c.latencyMs)} ms</td>
                        <td className="mono muted">{c.upstream.status ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {admin && <DebugPanel callId={callId} />}
          </>
        )}
      </div>
    </Drawer>
  );
}

function DebugPanel({ callId }: { callId: string }) {
  const t = useT();
  const debug = useMutation({ mutationFn: () => api<CapturedCall>(`/calls/${callId}/debug`) });
  const replay = useMutation({ mutationFn: () => api<ReplayResult>(`/calls/${callId}/replay`, { method: 'POST' }) });
  const notCaptured = (debug.error as { status?: number } | null)?.status === 404;
  const raw = debug.data ? (debug.data.upstream?.body ?? debug.data.steps) : undefined;
  const signed = (n: number | null) => (n == null ? '—' : `${n > 0 ? '+' : ''}${fmtNumber(n)}`);
  return (
    <div className="panel" data-testid="debug-panel">
      <div className="panel-head">
        <span className="panel-title">{t('calls.debug')}</span>
      </div>
      <div className="panel-body stack">
        <div className="row">
          <button className="btn" onClick={() => debug.mutate()} disabled={debug.isPending}>
            <Bug size={14} /> {t('calls.loadDebug')}
          </button>
          <button className="btn" onClick={() => replay.mutate()} disabled={replay.isPending || notCaptured}>
            <RotateCcw size={14} /> {t('calls.replay')}
          </button>
        </div>
        {notCaptured ? <span className="hint">{t('calls.debugNone')}</span> : <ErrorBox error={debug.error} />}
        {debug.data && <DiffView before={raw} after={debug.data.final} maxHeight={360} />}
        <ErrorBox error={replay.error} />
        {replay.data && (
          <>
            <div className={`alert ${replay.data.deltas.decisionChanged ? 'warn' : 'ok'}`}>
              {t('calls.replayDone', {
                decision: replay.data.replayed.decision,
                bytes: fmtNumber(replay.data.replayed.responseBytes ?? 0),
                deltaBytes: signed(replay.data.deltas.responseBytes),
                redactions: fmtNumber(replay.data.replayed.redactions),
                deltaRedactions: signed(replay.data.deltas.redactions),
              })}
            </div>
            <div className="grid-2">
              <div>
                <div className="label">{t('calls.replayOriginal')}</div>
                <JsonView value={replay.data.original.final} maxHeight={300} />
              </div>
              <div>
                <div className="label">{t('calls.replayNew')}</div>
                <JsonView value={replay.data.replayed.final} maxHeight={300} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Captures() {
  const t = useT();
  const toast = useToast();
  const invalidate = useInvalidate();
  const list = useTenantQuery<{ enabled: boolean; items: DebugCapture[] }>(['debug-captures'], '/debug-captures');
  const [form, setForm] = useState({ reason: '', tool: '', subject: '', maxCalls: 20, minutes: 15 });
  const create = useMutation({
    mutationFn: () =>
      api<DebugCapture>('/debug-captures', {
        method: 'POST',
        body: {
          reason: form.reason,
          filter: { ...(form.tool ? { tool: form.tool } : {}), ...(form.subject ? { subject: form.subject } : {}) },
          maxCalls: form.maxCalls,
          minutes: form.minutes,
        },
      }),
    onSuccess: () => {
      toast('ok', t('calls.captureStart'));
      void invalidate('debug-captures');
    },
  });
  const stop = useMutation({ mutationFn: (id: string) => api(`/debug-captures/${id}`, { method: 'DELETE' }), onSuccess: () => void invalidate('debug-captures') });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  if (list.data && !list.data.enabled) return <div className="alert warn">{t('calls.captureDisabled')}</div>;
  return (
    <>
      <div className="panel" style={{ maxWidth: 900 }}>
        <div className="panel-head">
          <span className="panel-title">{t('calls.newCapture')}</span>
        </div>
        <form className="panel-body stack" onSubmit={submit}>
          <span className="hint">{t('calls.captureHint')}</span>
          <Field label={t('calls.captureReason')}>
            <input className="input" required minLength={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} aria-label={t('calls.captureReason')} />
          </Field>
          <div className="grid-2">
            <Field label={t('calls.captureTool')}>
              <input className="input mono" value={form.tool} onChange={(e) => setForm({ ...form, tool: e.target.value })} aria-label={t('calls.captureTool')} />
            </Field>
            <Field label={t('calls.captureSubject')}>
              <input className="input mono" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} aria-label={t('calls.captureSubject')} />
            </Field>
            <Field label={t('calls.captureMax')}>
              <input className="input mono" type="number" min={1} max={100} value={form.maxCalls} onChange={(e) => setForm({ ...form, maxCalls: Number(e.target.value) || 1 })} aria-label={t('calls.captureMax')} />
            </Field>
            <Field label={t('calls.captureMinutes')}>
              <input className="input mono" type="number" min={1} max={60} value={form.minutes} onChange={(e) => setForm({ ...form, minutes: Number(e.target.value) || 1 })} aria-label={t('calls.captureMinutes')} />
            </Field>
          </div>
          <ErrorBox error={create.error} />
          <div className="row">
            <button className="btn primary" type="submit" disabled={create.isPending}>
              {t('calls.captureStart')}
            </button>
          </div>
        </form>
      </div>
      <table className="table" style={{ marginTop: 16 }}>
        <thead>
          <tr>
            <th>{t('calls.colReason')}</th>
            <th>{t('calls.colStatus')}</th>
            <th>{t('calls.colCaptured')}</th>
            <th>{t('calls.colExpires')}</th>
            <th>{t('calls.colBy')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(list.data?.items ?? []).map((c) => (
            <tr key={c.id}>
              <td>{c.reason}</td>
              <td>
                <Badge kind={c.status === 'active' ? 'ok' : undefined}>{c.status}</Badge>
              </td>
              <td className="mono">
                {c.capturedCount}/{c.maxCalls}
              </td>
              <td className="muted">{fmtDate(c.expiresAt)}</td>
              <td className="mono muted">{c.createdBy}</td>
              <td>
                {c.status === 'active' && (
                  <button className="btn sm ghost" onClick={() => stop.mutate(c.id)}>
                    {t('calls.captureStop')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

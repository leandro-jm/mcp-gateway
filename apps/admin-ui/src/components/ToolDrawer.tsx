import { formatPercent } from '@mcp-gateway/i18n';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CircleCheck, CirclePause, Archive } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useSession } from '../api/session';
import type { Decision, PlaygroundResult, Projection, Tool, ToolVersion } from '../api/types';
import { getLocale, useT } from '../i18n';
import { useInvalidate } from '../lib/hooks';
import { DECISION_LABEL, DRIFT_KIND_LABEL, enumLabel, TOOL_KIND_LABEL, TOOL_STATE_LABEL } from '../lib/labels';
import { rich } from '../lib/rich';
import { argsSkeleton, lines, parseJson } from '../lib/schema';
import { DiffView } from './DiffView';
import { Editor } from './Editor';
import { useToast } from './toast';
import { ViewTab } from './ViewTab';
import { Badge, Drawer, ErrorBox, Field, fmtBytes, fmtDate, JsonView, Tabs } from './ui';

type Tab = 'overview' | 'versions' | 'projection' | 'view' | 'test';

export function StateBadge({ state }: { state: string }) {
  const t = useT();
  return <Badge kind={state}>{enumLabel(t, TOOL_STATE_LABEL, state)}</Badge>;
}

/** Tool kind badge (openapi / manual / composite). */
export function KindBadge({ kind }: { kind: string }) {
  const t = useT();
  return <Badge>{enumLabel(t, TOOL_KIND_LABEL, kind)}</Badge>;
}

export function ToolDrawer({ toolId, onClose }: { toolId: string; onClose(): void }) {
  const t = useT();
  const { tenant } = useSession();
  const invalidate = useInvalidate();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('overview');
  const tool = useQuery({ queryKey: [tenant, 'tool', toolId], queryFn: () => api<Tool>(`/tools/${toolId}`) });

  const transition = useMutation({
    mutationFn: (action: 'enable' | 'disable' | 'deprecate') => api<Tool>(`/tools/${toolId}/${action}`, { method: 'POST' }),
    onSuccess: (updated) => {
      toast('ok', t('toolDrawer.transitioned', { name: updated.name, state: enumLabel(t, TOOL_STATE_LABEL, updated.state) }));
      void invalidate('tool', toolId);
      void invalidate('tools');
    },
    onError: (e) => toast('error', (e as Error).message),
  });

  const tl = tool.data;
  const actions = tl && tl.state !== 'removed' && (
    <>
      {tl.state !== 'enabled' && (
        <button className="btn sm primary" onClick={() => transition.mutate('enable')} disabled={transition.isPending}>
          <CircleCheck size={16} /> {t('toolDrawer.enable')}
        </button>
      )}
      {tl.state === 'enabled' && (
        <button className="btn sm" onClick={() => transition.mutate('disable')} disabled={transition.isPending}>
          <CirclePause size={16} /> {t('toolDrawer.disable')}
        </button>
      )}
      {tl.state !== 'deprecated' && (
        <button className="btn sm" onClick={() => transition.mutate('deprecate')} disabled={transition.isPending}>
          <Archive size={16} /> {t('toolDrawer.deprecate')}
        </button>
      )}
    </>
  );

  return (
    <Drawer
      title={tl?.name ?? '…'}
      onClose={onClose}
      actions={actions}
      subtitle={
        tl && (
          <div className="chips">
            <StateBadge state={tl.state} />
            <KindBadge kind={tl.kind} />
            {tl.annotations.readOnlyHint && <Badge kind="ok">{t('common.annotationReadOnly')}</Badge>}
            {tl.annotations.destructiveHint && <Badge kind="destructive">{t('common.annotationDestructive')}</Badge>}
            {tl.operationRef && (
              <span className="mono muted" style={{ fontSize: 13 }}>
                {tl.operationRef.method} {tl.operationRef.path}
              </span>
            )}
            <span className="muted" style={{ fontSize: 13 }}>
              v{tl.version}
            </span>
          </div>
        )
      }
    >
      <Tabs<Tab>
        tabs={[
          { id: 'overview', label: t('toolDrawer.tabOverview') },
          { id: 'versions', label: t('toolDrawer.tabVersions') },
          { id: 'projection', label: t('toolDrawer.tabProjection') },
          { id: 'view', label: t('views.tab') },
          { id: 'test', label: t('toolDrawer.tabTest') },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="drawer-body">
        {tool.error ? <ErrorBox error={tool.error} /> : null}
        {tl && tab === 'overview' && <Overview tool={tl} />}
        {tl && tab === 'versions' && <Versions tool={tl} />}
        {tl && tab === 'projection' && <ProjectionTab tool={tl} />}
        {tl && tab === 'view' && <ViewTab tool={tl} />}
        {tl && tab === 'test' && <TestTab tool={tl} />}
      </div>
    </Drawer>
  );
}

function Overview({ tool }: { tool: Tool }) {
  const t = useT();
  const { me } = useSession();
  const invalidate = useInvalidate();
  const toast = useToast();
  const o = tool.overrides as { name?: string; title?: string; description?: string; inputSchema?: unknown };
  const [name, setName] = useState(o.name ?? '');
  const [title, setTitle] = useState(o.title ?? tool.title ?? '');
  const [description, setDescription] = useState(tool.description);
  const [patch, setPatch] = useState(o.inputSchema ? JSON.stringify(o.inputSchema, null, 2) : '');
  const save = useMutation({
    mutationFn: () => {
      const p: { value?: Record<string, unknown> | null; error?: string } = patch.trim() ? parseJson<Record<string, unknown>>(patch) : { value: null };
      if (p.error) throw new Error(t('toolDrawer.invalidSchemaPatch', { error: p.error }));
      return api<Tool>(`/tools/${tool.id}`, {
        method: 'PATCH',
        body: { ...(me.isAdmin ? { name: name.trim() || null } : {}), title: title.trim() || null, description: description.trim() || null, inputSchema: p.value ?? null },
      });
    },
    onSuccess: () => {
      toast('ok', t('toolDrawer.overridesSaved'));
      void invalidate('tool', tool.id);
      void invalidate('tools');
    },
  });
  return (
    <div className="stack">
      <dl className="kv">
        <dt>{t('toolDrawer.generatedName')}</dt>
        <dd className="mono">{tool.baseName}</dd>
        <dt>{t('common.owner')}</dt>
        <dd>{tool.ownerTeam ?? '—'}</dd>
        <dt>{t('toolDrawer.updated')}</dt>
        <dd>{fmtDate(tool.updatedAt)}</dd>
      </dl>
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">{t('toolDrawer.ownerOverrides')}</span>
          <span className="hint">{t('toolDrawer.overridesHint')}</span>
        </div>
        <div className="panel-body">
          <div className="grid-2">
            <Field label={t('common.name')} {...(me.isAdmin ? {} : { hint: t('toolDrawer.renameAdminOnly') })}>
              <input className="input mono" value={name} placeholder={tool.baseName} onChange={(e) => setName(e.target.value)} disabled={!me.isAdmin} aria-label={t('common.name')} />
            </Field>
            <Field label={t('common.title')}>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} aria-label={t('common.title')} />
            </Field>
          </div>
          <Field label={t('common.description')} hint={t('toolDrawer.descriptionHint')}>
            <textarea className="textarea" style={{ fontFamily: 'var(--font-sans)', fontSize: 14 }} value={description} onChange={(e) => setDescription(e.target.value)} aria-label={t('common.description')} />
          </Field>
          <Field label={t('toolDrawer.inputSchemaPatch')}>
            <Editor value={patch} onChange={setPatch} height="140px" label={t('toolDrawer.inputSchemaPatchEditor')} />
          </Field>
          <ErrorBox error={save.error} />
          <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {t('toolDrawer.saveOverrides')}
          </button>
        </div>
      </div>
      <div className="split panel">
        <div className="panel-body">
          <div className="label" style={{ marginBottom: 8 }}>
            {t('toolDrawer.effectiveInputSchema')}
          </div>
          <JsonView value={tool.inputSchema} maxHeight={360} />
        </div>
        <div className="panel-body">
          <div className="label" style={{ marginBottom: 8 }}>
            {t('toolDrawer.outputSchema')}
          </div>
          <JsonView value={tool.outputSchema ?? '—'} maxHeight={360} />
        </div>
      </div>
    </div>
  );
}

function Versions({ tool }: { tool: Tool }) {
  const t = useT();
  const { tenant } = useSession();
  const versions = useQuery({ queryKey: [tenant, 'tool', tool.id, 'versions'], queryFn: () => api<{ items: ToolVersion[] }>(`/tools/${tool.id}/versions`) });
  const items = versions.data?.items ?? [];
  const [to, setTo] = useState<number | null>(null);
  const [from, setFrom] = useState<number | null>(null);
  useEffect(() => {
    if (items.length) {
      setTo(items[0]!.version);
      setFrom(items[1]?.version ?? items[0]!.version);
    }
  }, [versions.data]);
  const a = items.find((v) => v.version === from);
  const b = items.find((v) => v.version === to);
  return (
    <div className="stack">
      <table className="table">
        <thead>
          <tr>
            <th>{t('common.version')}</th>
            <th>{t('toolDrawer.changes')}</th>
            <th>{t('toolDrawer.specHash')}</th>
            <th>{t('toolDrawer.created')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((v) => (
            <tr key={v.version}>
              <td className="mono">v{v.version}</td>
              <td>
                {v.diff?.summary ?? <span className="dim">{t('toolDrawer.initialVersion')}</span>}
                {v.diff?.changes?.some((c) => c.breaking) && (
                  <>
                    {' '}
                    <Badge kind="breaking">{enumLabel(t, DRIFT_KIND_LABEL, 'breaking')}</Badge>
                  </>
                )}
              </td>
              <td className="mono dim">{v.specHash?.slice(0, 10) ?? '—'}</td>
              <td className="muted nowrap">{fmtDate(v.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length > 1 && (
        <>
          <div className="row">
            <span className="label">{t('toolDrawer.compare')}</span>
            <select className="select" style={{ width: 120 }} value={from ?? ''} onChange={(e) => setFrom(Number(e.target.value))} aria-label={t('toolDrawer.fromVersion')}>
              {items.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version}
                </option>
              ))}
            </select>
            <span className="muted">→</span>
            <select className="select" style={{ width: 120 }} value={to ?? ''} onChange={(e) => setTo(Number(e.target.value))} aria-label={t('toolDrawer.toVersion')}>
              {items.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version}
                </option>
              ))}
            </select>
          </div>
          {a && b && <DiffView before={{ input: a.inputSchema, output: a.outputSchema }} after={{ input: b.inputSchema, output: b.outputSchema }} />}
        </>
      )}
    </div>
  );
}

function ProjectionTab({ tool }: { tool: Tool }) {
  const t = useT();
  const { tenant, me } = useSession();
  const invalidate = useInvalidate();
  const toast = useToast();
  const current = useQuery({
    queryKey: [tenant, 'projection', tool.id],
    queryFn: async () => {
      try {
        return await api<Projection>(`/tools/${tool.id}/projection`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
  });
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [maxItems, setMaxItems] = useState('');
  const [maxBytes, setMaxBytes] = useState('');
  const [agentFields, setAgentFields] = useState(false);
  const [sample, setSample] = useState('');
  const [sampleArgs, setSampleArgs] = useState(JSON.stringify(argsSkeleton(tool.inputSchema), null, 2));
  const [loaded, setLoaded] = useState(false);
  // Initialize the form only once: refetches must not wipe what the owner is editing.
  useEffect(() => {
    const p = current.data;
    if (p === undefined || loaded) return;
    setInclude((p?.include ?? []).join('\n'));
    setExclude((p?.exclude ?? []).join('\n'));
    setMaxItems(p?.maxArrayItems ? String(p.maxArrayItems) : '');
    setMaxBytes(p?.maxBytes ? String(p.maxBytes) : '');
    setAgentFields(p?.allowAgentFields ?? false);
    setLoaded(true);
  }, [current.data, loaded]);

  const draft = () => ({
    include: lines(include),
    exclude: lines(exclude),
    maxArrayItems: maxItems ? Number(maxItems) : null,
    maxBytes: maxBytes ? Number(maxBytes) : null,
    allowAgentFields: agentFields,
    status: 'active' as const,
  });
  const save = useMutation({
    mutationFn: () => api<Projection>(`/tools/${tool.id}/projection`, { method: 'PUT', body: draft() }),
    onSuccess: () => {
      toast('ok', t('toolDrawer.projectionSaved'));
      void invalidate('projection', tool.id);
      void invalidate('projections');
    },
  });
  const loadSample = useMutation({
    mutationFn: () => {
      const args = parseJson<Record<string, unknown>>(sampleArgs);
      if (args.error) throw new Error(t('common.invalidArgs', { error: args.error }));
      return api<PlaygroundResult>('/playground/call', { method: 'POST', body: { tool: tool.name, arguments: args.value, subject: { sub: me.sub, roles: ['agent'] } } });
    },
    onSuccess: (r) => setSample(JSON.stringify(r.raw ?? r.final, null, 2)),
  });
  const preview = useMutation({
    mutationFn: () => {
      const payload = parseJson(sample);
      if (payload.error) throw new Error(t('common.invalidPayload', { error: payload.error }));
      return api<{ projected: unknown; bytesBefore: number; bytesAfter: number; bytesSaved: number; ratio: number }>(`/tools/${tool.id}/projection/preview`, {
        method: 'POST',
        body: { payload: payload.value, projection: draft() },
      });
    },
  });

  if (!loaded) return <div className="loading">{t('toolDrawer.loadingProjection')}</div>;
  return (
    <div className="stack">
      {current.data?.status === 'suggested' && (
        <div className="alert warn">{t('toolDrawer.projectionSuggested')}</div>
      )}
      <div className="grid-2">
        <Field label={t('toolDrawer.includeField')} hint={t('common.example', { example: '$.items[*].id' })}>
          <textarea className="textarea" value={include} onChange={(e) => setInclude(e.target.value)} aria-label={t('toolDrawer.include')} />
        </Field>
        <Field label={t('toolDrawer.excludeField')}>
          <textarea className="textarea" value={exclude} onChange={(e) => setExclude(e.target.value)} aria-label={t('toolDrawer.exclude')} />
        </Field>
      </div>
      <div className="grid-2">
        <Field label={t('toolDrawer.maxItemsField')}>
          <input className="input" inputMode="numeric" value={maxItems} onChange={(e) => setMaxItems(e.target.value.replace(/\D/g, ''))} aria-label={t('toolDrawer.maxItems')} />
        </Field>
        <Field label={t('toolDrawer.maxBytesField')}>
          <input className="input" inputMode="numeric" value={maxBytes} onChange={(e) => setMaxBytes(e.target.value.replace(/\D/g, ''))} aria-label={t('toolDrawer.maxBytes')} />
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={agentFields} onChange={(e) => setAgentFields(e.target.checked)} /> {rich(t, 'toolDrawer.allowAgentFields', { fields: <code>_fields</code> })}
      </label>
      <ErrorBox error={save.error} />
      <div className="row">
        <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>
          {t('toolDrawer.saveProjection')}
        </button>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">{t('toolDrawer.previewTitle')}</span>
        </div>
        <div className="panel-body stack">
          <div className="grid-2">
            <Field label={t('toolDrawer.sampleArgsField')}>
              <Editor value={sampleArgs} onChange={setSampleArgs} height="110px" label={t('toolDrawer.sampleArgs')} />
            </Field>
            <div className="stack" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => loadSample.mutate()} disabled={loadSample.isPending}>
                {t('toolDrawer.loadUpstream')}
              </button>
              <ErrorBox error={loadSample.error} />
            </div>
          </div>
          <Field label={t('toolDrawer.samplePayload')}>
            <Editor value={sample} onChange={setSample} height="200px" label={t('toolDrawer.samplePayload')} />
          </Field>
          <button className="btn accent" onClick={() => preview.mutate()} disabled={!sample || preview.isPending}>
            {t('common.preview')}
          </button>
          <ErrorBox error={preview.error} />
          {preview.data && (
            <>
              <div className="chips" data-testid="projection-savings">
                <Badge>{t('toolDrawer.bytesBefore', { bytes: fmtBytes(preview.data.bytesBefore) })}</Badge>
                <Badge>{t('toolDrawer.bytesAfter', { bytes: fmtBytes(preview.data.bytesAfter) })}</Badge>
                <Badge kind="ok">{t('toolDrawer.bytesSavings', { bytes: fmtBytes(preview.data.bytesSaved), percent: formatPercent(getLocale(), preview.data.ratio) })}</Badge>
              </div>
              <JsonView value={preview.data.projected} maxHeight={320} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TestTab({ tool }: { tool: Tool }) {
  const t = useT();
  const { me } = useSession();
  const [roles, setRoles] = useState('agent');
  const [groups, setGroups] = useState('');
  const [args, setArgs] = useState(JSON.stringify(argsSkeleton(tool.inputSchema), null, 2));
  const subject = useMemo(
    () => ({
      sub: 'simulator',
      roles: roles.split(',').map((r) => r.trim()).filter(Boolean),
      groups: groups.split(',').map((g) => g.trim()).filter(Boolean),
    }),
    [roles, groups],
  );
  const simulate = useMutation({
    mutationFn: () => {
      const a = parseJson<Record<string, unknown>>(args);
      return api<Decision>('/policies/simulate', { method: 'POST', body: { subject, tool: tool.name, ...(a.value ? { args: a.value } : {}) } });
    },
  });
  const run = useMutation({
    mutationFn: () => {
      const a = parseJson<Record<string, unknown>>(args);
      if (a.error) throw new Error(t('common.invalidArgs', { error: a.error }));
      return api<PlaygroundResult>('/playground/call', { method: 'POST', body: { tool: tool.name, arguments: a.value, subject } });
    },
  });
  return (
    <div className="stack">
      <div className="grid-2">
        <Field label={t('common.simulatedSubjectRoles')} hint={t('common.commaSeparated')}>
          <input className="input mono" value={roles} onChange={(e) => setRoles(e.target.value)} aria-label={t('common.roles')} />
        </Field>
        <Field label={t('common.groups')}>
          <input className="input mono" value={groups} onChange={(e) => setGroups(e.target.value)} aria-label={t('common.groups')} />
        </Field>
      </div>
      <Field label={t('common.arguments')}>
        <Editor value={args} onChange={setArgs} height="160px" label={t('common.arguments')} />
      </Field>
      <div className="row">
        <button className="btn" onClick={() => simulate.mutate()} disabled={simulate.isPending}>
          {t('toolDrawer.simulatePolicy')}
        </button>
        <button className="btn primary" onClick={() => run.mutate()} disabled={run.isPending}>
          {t('toolDrawer.runAsSubject')}
        </button>
        {!me.isAdmin && <span className="hint">{t('toolDrawer.rawAdminOnly')}</span>}
      </div>
      <ErrorBox error={simulate.error ?? run.error} />
      {simulate.data && (
        <div className={`alert ${simulate.data.effect === 'allow' ? 'ok' : 'error'}`} data-testid="simulation">
          <strong>{simulate.data.effect === 'allow' ? t('common.allowed') : t('common.denied')}</strong> · {simulate.data.reason} — {simulate.data.explanation}
        </div>
      )}
      {run.data && (
        <div className="stack" data-testid="test-result">
          <div className="chips">
            <Badge kind={run.data.decision}>{enumLabel(t, DECISION_LABEL, run.data.decision)}</Badge>
            {run.data.status && <Badge>{t('common.httpStatus', { status: run.data.status })}</Badge>}
            <Badge>{t('common.redactions', { count: run.data.redactions })}</Badge>
            <Badge>{t('common.bytesSaved', { bytes: fmtBytes(run.data.bytesSaved) })}</Badge>
            <Badge>{t('common.durationMs', { ms: run.data.durationMs })}</Badge>
          </div>
          <JsonView value={run.data.final} maxHeight={360} />
        </div>
      )}
    </div>
  );
}

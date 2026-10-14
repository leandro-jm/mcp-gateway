import { useMutation } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { Page, PlaygroundResult, Tool } from '../api/types';
import { DiffView } from '../components/DiffView';
import { Editor } from '../components/Editor';
import { Badge, ErrorBox, Field, fmtBytes, fmtNumber, JsonView, PageHeader, Tabs } from '../components/ui';
import { useT } from '../i18n';
import { useTenantQuery } from '../lib/hooks';
import { argsSkeleton, parseJson } from '../lib/schema';
import { ToolUiPreview } from '../components/ToolUiPreview';

/** F10.2: calls a tool as a simulated subject and shows the final × raw response, with the differences highlighted. */
export function PlaygroundPage() {
  const t = useT();
  const tools = useTenantQuery<Page<Tool>>(['tools', 'enabled'], '/tools?state=enabled&limit=500');
  const [toolName, setToolName] = useState('');
  const [args, setArgs] = useState('{}');
  const [roles, setRoles] = useState('agent');
  const [groups, setGroups] = useState('');
  const [claims, setClaims] = useState('{}');
  const [simulateUi, setSimulateUi] = useState(false);
  const tool = useMemo(() => tools.data?.items.find((item) => item.name === toolName), [tools.data, toolName]);
  useEffect(() => {
    if (!toolName && tools.data?.items[0]) setToolName(tools.data.items[0].name);
  }, [tools.data, toolName]);
  useEffect(() => {
    if (tool) setArgs(JSON.stringify(argsSkeleton(tool.inputSchema), null, 2));
  }, [tool]);

  const subjectOf = (claimsValue: Record<string, unknown>) => ({
    sub: 'playground',
    roles: roles.split(',').map((r) => r.trim()).filter(Boolean),
    groups: groups.split(',').map((g) => g.trim()).filter(Boolean),
    claims: claimsValue,
  });

  const run = useMutation({
    mutationFn: () => {
      const a = parseJson<Record<string, unknown>>(args);
      const c = parseJson<Record<string, unknown>>(claims);
      if (a.error) throw new Error(t('common.invalidArgs', { error: a.error }));
      if (c.error) throw new Error(t('playground.invalidClaims', { error: c.error }));
      return api<PlaygroundResult>('/playground/call', {
        method: 'POST',
        body: { tool: toolName, arguments: a.value, subject: subjectOf(c.value ?? {}), ui: simulateUi },
      }).then((res) => ({ ...res, args: a.value ?? {}, subject: subjectOf(c.value ?? {}) }));
    },
  });
  const r = run.data;

  return (
    <>
      <PageHeader title={t('playground.title')} subtitle={t('playground.subtitle')} />
      <Tabs tabs={[{ id: 'call', label: t('playground.tabCall'), icon: <FlaskConical size={20} /> }]} value="call" onChange={() => undefined} />
      <div className="content stack">
        <div className="grid-2" style={{ alignItems: 'start' }}>
          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">{t('playground.request')}</span>
            </div>
            <div className="panel-body">
              <Field label={t('common.tool')}>
                <select className="select mono" value={toolName} onChange={(e) => setToolName(e.target.value)} aria-label={t('common.tool')}>
                  {(tools.data?.items ?? []).map((item) => (
                    <option key={item.id} value={item.name}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
              {tool && <p className="hint" style={{ marginTop: -8 }}>{tool.description}</p>}
              <Field label={t('common.arguments')}>
                <Editor value={args} onChange={setArgs} height="180px" label={t('common.arguments')} />
              </Field>
              <label className="row" style={{ gap: 6, marginBottom: 12 }} title={t('views.simulateUiHint')}>
                <input type="checkbox" checked={simulateUi} onChange={(e) => setSimulateUi(e.target.checked)} /> {t('views.simulateUi')}
              </label>
              <button className="btn primary" onClick={() => run.mutate()} disabled={!toolName || run.isPending}>
                {t('common.run')}
              </button>
            </div>
          </div>
          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">{t('common.simulatedSubject')}</span>
            </div>
            <div className="panel-body">
              <div className="grid-2">
                <Field label={t('common.roles')}>
                  <input className="input mono" value={roles} onChange={(e) => setRoles(e.target.value)} aria-label={t('common.roles')} />
                </Field>
                <Field label={t('common.groups')}>
                  <input className="input mono" value={groups} onChange={(e) => setGroups(e.target.value)} aria-label={t('common.groups')} />
                </Field>
              </div>
              <Field label={t('common.claimsJson')} hint={t('playground.claimsHint', { example: '{"unidades":["uni-1"]}' })}>
                <Editor value={claims} onChange={setClaims} height="110px" label={t('playground.claims')} />
              </Field>
            </div>
          </div>
        </div>
        <ErrorBox error={run.error} />
        {r && (
          <>
            <div className="chips" data-testid="playground-meta">
              <Badge kind={r.decision}>{r.decision}</Badge>
              {r.status && <Badge>{t('common.httpStatus', { status: r.status })}</Badge>}
              <Badge kind={r.redactions ? 'accent' : undefined}>{t('common.redactions', { count: r.redactions })}</Badge>
              <Badge>{t('common.bytesSaved', { bytes: fmtBytes(r.bytesSaved) })}</Badge>
              {r.artifactId && <Badge kind="accent">{t('playground.artifact')}</Badge>}
              <Badge>{t('common.durationMs', { ms: fmtNumber(r.durationMs) })}</Badge>
            </div>
            {simulateUi && (
              <div className="panel" data-testid="playground-view">
                <div className="panel-head">
                  <span className="panel-title">{t('views.panelTitle')}</span>
                </div>
                <div className="panel-body">
                  <ToolUiPreview result={r.result} args={r.args} subject={r.subject} />
                </div>
              </div>
            )}
            <div className="split panel">
              <div className="panel-body">
                <div className="label" style={{ marginBottom: 8 }}>
                  {t('playground.finalLabel')}
                </div>
                <JsonView value={r.final} maxHeight={520} />
              </div>
              <div className="panel-body">
                <div className="label" style={{ marginBottom: 8 }}>
                  {t(r.rawVisible ? 'playground.rawLabel' : 'playground.rawLabelRestricted')}
                </div>
                {r.rawVisible ? <JsonView value={r.raw} maxHeight={520} /> : <p className="muted">{t('playground.rawUnavailable')}</p>}
              </div>
            </div>
            {r.rawVisible && (
              <div className="panel">
                <div className="panel-head">
                  <span className="panel-title">{t('playground.diffTitle')}</span>
                  <span className="hint">{t('playground.diffLegend')}</span>
                </div>
                <div className="panel-body">
                  <DiffView before={r.raw} after={r.final} />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

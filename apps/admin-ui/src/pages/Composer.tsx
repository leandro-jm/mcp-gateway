import { useMutation } from '@tanstack/react-query';
import { Sparkles, Workflow } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api/client';
import { useSession } from '../api/session';
import type { ComposerProposal, Composite, CompositeReadiness, CompositeValidation, LlmSettings } from '../api/types';
import { Dag } from '../components/Dag';
import { Editor } from '../components/Editor';
import { PublishWizard } from '../components/PublishWizard';
import { useToast } from '../components/toast';
import { Badge, ErrorBox, Field, fmtNumber, JsonView, PageHeader, Tabs } from '../components/ui';
import { useT, type UiMessageKey } from '../i18n';
import { useInvalidate, useTenantQuery } from '../lib/hooks';
import { parseJson } from '../lib/schema';

const TEMPLATE = `name: rh_resumo_colaborador
title: Resumo do colaborador
description: Dados do colaborador, escala atual e últimas marcações
input:
  type: object
  required: [colaborador_id]
  properties:
    colaborador_id: { type: string }
    desde: { type: string, format: date }
steps:
  - id: colab
    tool: rh_colaborador_get
    args: { id: "$input.colaborador_id" }
  - id: escalas
    tool: rh_escalas_list
    args: { colaborador: "$steps.colab.id" }
  - id: marcacoes
    tool: rh_marcacoes_list
    args: { colaborador: "$steps.colab.id", desde: "$input.desde" }
    when: "$exists($input.desde)"
output: |
  {
    "nome": $steps.colab.nome,
    "escala_atual": $steps.escalas[0],
    "ultimas_marcacoes": $steps.marcacoes[[0..9]]
  }
failure_mode: partial
timeout_ms: 8000
`;

const STATUS_LABELS: Record<Composite['status'], UiMessageKey> = { draft: 'composer.statusDraft', valid: 'composer.statusValid', invalid: 'composer.statusInvalid' };
const STEP_STATUS_LABELS: Record<string, UiMessageKey> = { ok: 'composer.stepOk', skipped: 'composer.stepSkipped', failed: 'composer.stepFailed' };
const STEP_STATUS_KIND: Record<string, string> = { ok: 'ok', skipped: 'warn', failed: 'error' };

type Tab = 'nl' | 'edit';

function Issues({ validation }: { validation: CompositeValidation }) {
  return (
    <>
      {validation.errors.map((e, i) => (
        <div key={i} className="alert error">
          <span className="mono">{e.path}</span>: {e.message}
        </div>
      ))}
      {validation.warnings.map((e, i) => (
        <div key={i} className="alert warn">
          <span className="mono">{e.path}</span>: {e.message}
        </div>
      ))}
    </>
  );
}

export function ComposerPage() {
  const t = useT();
  const toast = useToast();
  const invalidate = useInvalidate();
  const composites = useTenantQuery<{ items: Composite[] }>(['composites'], '/composites');
  const [selected, setSelected] = useState<Composite | null>(null);
  const [source, setSource] = useState(TEMPLATE);
  const [validation, setValidation] = useState<CompositeValidation | null>(null);
  const [input, setInput] = useState('{\n  "colaborador_id": ""\n}');
  const [roles, setRoles] = useState('agent');
  const [allowWrites, setAllowWrites] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { me } = useSession();
  const [tab, setTab] = useState<Tab>('nl');
  const llm = useTenantQuery<LlmSettings>(['settings', 'llm'], '/settings/llm');
  const [prompt, setPrompt] = useState('');
  const [refinement, setRefinement] = useState('');
  const [proposal, setProposal] = useState<ComposerProposal | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [params, setParams] = useSearchParams();

  // deep links (F15.24): `?open=<compositeId>` opens a composite (e.g. an accepted suggestion),
  // `?prompt=<text>` prefills the natural-language request
  useEffect(() => {
    const open = params.get('open');
    const c = open ? composites.data?.items.find((x) => x.id === open) : undefined;
    if (c) {
      setSelected(c);
      setSource(c.source ?? '');
      setTab('edit');
      setParams({}, { replace: true });
    }
  }, [params, composites.data]);
  useEffect(() => {
    const p = params.get('prompt');
    if (p) {
      setPrompt(p);
      setTab('nl');
      setParams({}, { replace: true });
    }
  }, [params]);

  const readiness = useTenantQuery<CompositeReadiness>(['composites', selected?.id, 'readiness', 'agent'], selected ? `/composites/${selected.id}/readiness?roles=agent` : null);

  // live validation (debounced)
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api<CompositeValidation>('/composites/validate', { method: 'POST', body: { source } }).then(setValidation, () => setValidation(null));
    }, 400);
    return () => clearTimeout(timer.current);
  }, [source]);

  const save = useMutation({
    mutationFn: () =>
      selected ? api<Composite>(`/composites/${selected.id}`, { method: 'PUT', body: { source } }) : api<Composite>('/composites', { method: 'POST', body: { source } }),
    onSuccess: (c) => {
      toast(c.status === 'valid' ? 'ok' : 'error', t('composer.saved', { name: c.name, version: c.version, status: t(STATUS_LABELS[c.status]) }));
      setSelected(c);
      void invalidate('composites');
      void invalidate('tools');
    },
  });
  const dryRun = useMutation({
    mutationFn: () => {
      const i = parseJson<Record<string, unknown>>(input);
      if (i.error) throw new Error(t('composer.invalidInput', { error: i.error }));
      return api<{ output: unknown; steps: Record<string, { status: string; value: unknown; error?: unknown; durationMs: number }>; rawVisible: boolean; durationMs: number }>(
        `/composites/${selected!.id}/dry-run`,
        { method: 'POST', body: { input: i.value, allowWrites, subject: { roles: roles.split(',').map((r) => r.trim()).filter(Boolean) } } },
      );
    },
  });

  const generate = useMutation({
    mutationFn: (refine: boolean) =>
      api<ComposerProposal>('/composites/generate', { method: 'POST', body: { prompt, ...(refine ? { previous: source, refinement } : {}) } }),
    onSuccess: (p) => {
      setProposal(p);
      // a generated draft is a new composite, never a new version of the selected one
      setSelected(null);
      if (p.proposal.source) setSource(p.proposal.source);
      setRefinement('');
    },
  });
  const accept = useMutation({
    mutationFn: () => api<Composite>('/composites', { method: 'POST', body: { source } }),
    onSuccess: (c) => {
      toast('ok', t('composer.accepted'));
      setSelected(c);
      setTab('edit');
      void invalidate('composites');
      void invalidate('tools');
    },
  });
  const enableTool = useMutation({
    mutationFn: (s: { toolId: string; tool: string }) => api(`/tools/${s.toolId}/enable`, { method: 'POST' }).then(() => s),
    onSuccess: (s) => {
      toast('ok', t('composer.toolEnabled', { tool: s.tool }));
      void readiness.refetch();
      void invalidate('tools');
    },
  });
  const disabledSteps = (readiness.data?.steps ?? []).filter((s) => s.toolId && s.state !== 'enabled');
  const dryRunStatus = dryRun.data ? Object.fromEntries(Object.entries(dryRun.data.steps).map(([id, st]) => [id, st.status])) : undefined;
  const llmReady = llm.data?.configured === true;

  return (
    <>
      <PageHeader title={t('composer.title')} subtitle={t('composer.subtitle')} />
      <Tabs<Tab>
        tabs={[
          { id: 'nl', label: t('composer.tabNatural'), icon: <Sparkles size={20} /> },
          { id: 'edit', label: t('composer.tabEditor'), icon: <Workflow size={20} /> },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="content" style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 24 }}>
        <div className="stack">
          <button
            className="btn"
            onClick={() => {
              setSelected(null);
              setProposal(null);
              setSource(TEMPLATE);
            }}
          >
            {t('composer.newComposite')}
          </button>
          <div className="label">{t('composer.composites')}</div>
          {(composites.data?.items ?? []).map((c) => (
            <button
              key={c.id}
              className="nav-item"
              style={{ background: selected?.id === c.id ? 'var(--surface-2)' : 'none', cursor: 'pointer', fontSize: 14, textAlign: 'left' }}
              onClick={() => {
                setSelected(c);
                setSource(c.source ?? '');
                setTab('edit');
              }}
            >
              <span className="mono" style={{ flex: 1 }}>
                {c.name}
              </span>
              <Badge kind={c.status}>{t(STATUS_LABELS[c.status])}</Badge>
            </button>
          ))}
        </div>
        {tab === 'nl' && (
          <div className="stack" data-testid="composer-nl">
            <p className="hint" style={{ margin: 0 }}>{t('composer.nlIntro')}</p>
            {llm.data && !llmReady && (
              <div className="alert warn row" data-testid="llm-not-configured">
                <span style={{ flex: 1 }}>{t('composer.nlNotConfigured')}</span>
                {me.isAdmin ? (
                  <Link className="btn sm" to="/settings">
                    {t('composer.nlGoToSettings')}
                  </Link>
                ) : (
                  <span>{t('composer.nlAskAdmin')}</span>
                )}
              </div>
            )}
            <Field label={t('composer.prompt')}>
              <textarea
                className="textarea"
                rows={3}
                aria-label={t('composer.prompt')}
                placeholder={t('composer.promptPlaceholder')}
                value={prompt}
                maxLength={2000}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </Field>
            <div className="row">
              <button className="btn primary" onClick={() => generate.mutate(false)} disabled={!llmReady || !prompt.trim() || generate.isPending}>
                {t('composer.generate')}
              </button>
              {generate.isPending && <span className="hint">{t('composer.generating')}</span>}
            </div>
            <ErrorBox error={generate.error} />
            {proposal && (
              <div className="panel" data-testid="proposal">
                <div className="panel-head">
                  <span className="panel-title">{t('composer.proposal')}</span>
                  <Badge kind={proposal.validation.valid ? 'valid' : 'invalid'}>{t(proposal.validation.valid ? 'composer.statusValid' : 'composer.statusInvalid')}</Badge>
                </div>
                <div className="panel-body stack">
                  {proposal.proposal.unsupported && <div className="alert warn">{t('composer.unsupported', { reason: proposal.proposal.unsupported })}</div>}
                  {proposal.proposal.explanation && (
                    <div>
                      <div className="label">{t('composer.explanation')}</div>
                      <p style={{ margin: '4px 0 0' }}>{proposal.proposal.explanation}</p>
                    </div>
                  )}
                  {proposal.proposal.assumptions.length > 0 && (
                    <div>
                      <div className="label">{t('composer.assumptions')}</div>
                      <ul style={{ margin: '4px 0 0' }}>
                        {proposal.proposal.assumptions.map((a, i) => (
                          <li key={i}>{a}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {proposal.validation.graph && proposal.validation.graph.nodes.length > 0 && (
                    <div>
                      <div className="label">{t('composer.graph')}</div>
                      <Dag graph={proposal.validation.graph} />
                    </div>
                  )}
                  <Issues validation={proposal.validation} />
                  <div>
                    <div className="label">{t('composer.candidates')}</div>
                    <div className="chips">
                      {proposal.candidates.map((c) => (
                        <Badge key={c.name} kind={c.state === 'enabled' ? undefined : c.state}>
                          {c.name}
                          {c.state !== 'enabled' ? ` · ${c.state}` : ''}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <span className="hint">
                    {t('composer.usage', {
                      model: proposal.usage.model,
                      attempts: proposal.usage.attempts,
                      input: fmtNumber(proposal.usage.inputTokens),
                      output: fmtNumber(proposal.usage.outputTokens),
                      seconds: (proposal.usage.durationMs / 1000).toFixed(1),
                    })}
                  </span>
                  {proposal.proposal.source && (
                    <>
                      <div className="row">
                        <input
                          className="input"
                          style={{ flex: 1 }}
                          aria-label={t('composer.refine')}
                          placeholder={t('composer.refinementPlaceholder')}
                          value={refinement}
                          maxLength={2000}
                          onChange={(e) => setRefinement(e.target.value)}
                        />
                        <button className="btn" onClick={() => generate.mutate(true)} disabled={!refinement.trim() || generate.isPending}>
                          {t('composer.refine')}
                        </button>
                      </div>
                      <ErrorBox error={accept.error} />
                      <div className="row">
                        <button className="btn primary" onClick={() => accept.mutate()} disabled={accept.isPending}>
                          {t('composer.accept')}
                        </button>
                        <button className="btn ghost" onClick={() => setTab('edit')}>
                          {t('composer.openInEditor')}
                        </button>
                        <span className="hint">{t('composer.startsDisabled')}</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
        {tab === 'edit' && (
          <div className="stack">
            <Editor value={source} onChange={setSource} language="yaml" height="420px" label={t('composer.yamlDefinition')} />
            {validation && (
              <div className="stack">
                <div className="chips">
                  <Badge kind={validation.valid ? 'valid' : 'invalid'}>{t(validation.valid ? 'composer.statusValid' : 'composer.statusInvalid')}</Badge>
                  {Object.entries(validation.annotations)
                    .filter(([, v]) => v)
                    .map(([k]) => (
                      <Badge key={k}>{k}</Badge>
                    ))}
                  {validation.dependsOn.map((d) => (
                    <Badge key={d}>{d}</Badge>
                  ))}
                </div>
                <Issues validation={validation} />
                {validation.graph && validation.graph.nodes.length > 0 && <Dag graph={validation.graph} status={dryRunStatus} />}
              </div>
            )}
            <ErrorBox error={save.error} />
            <div className="row">
              <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>
                {selected ? t('composer.saveVersion', { version: selected.version + 1 }) : t('composer.create')}
              </button>
              {selected && (
                <button className="btn accent" onClick={() => setPublishing(true)}>
                  {t('composer.publish')}
                </button>
              )}
              {selected && <span className="hint">{t('composer.startsDisabled')}</span>}
            </div>
            {selected && disabledSteps.length > 0 && (
              <div className="alert warn stack" data-testid="disabled-steps">
                <span>{t('composer.disabledSteps')}</span>
                <div className="row">
                  {disabledSteps.map((s) =>
                    s.canManage ? (
                      <button key={s.id} className="btn sm" disabled={enableTool.isPending} onClick={() => enableTool.mutate({ toolId: s.toolId!, tool: s.tool })}>
                        {t('composer.enableTool', { tool: s.tool })}
                      </button>
                    ) : (
                      <Badge key={s.id}>{s.tool}</Badge>
                    ),
                  )}
                </div>
                <ErrorBox error={enableTool.error} />
              </div>
            )}
            {selected && (
              <div className="panel">
                <div className="panel-head">
                  <span className="panel-title">{t('composer.dryRun')}</span>
                </div>
                <div className="panel-body stack">
                  <div className="grid-2">
                    <Field label={t('common.input')}>
                      <Editor value={input} onChange={setInput} height="120px" label={t('composer.dryRunInput')} />
                    </Field>
                    <div>
                      <Field label={t('common.simulatedSubjectRoles')}>
                        <input className="input mono" value={roles} onChange={(e) => setRoles(e.target.value)} />
                      </Field>
                      <label className="check">
                        <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} /> {t('composer.allowWrites')}
                      </label>
                    </div>
                  </div>
                  <button className="btn accent" onClick={() => dryRun.mutate()} disabled={dryRun.isPending}>
                    {t('composer.runDryRun')}
                  </button>
                  <ErrorBox error={dryRun.error} />
                  {dryRun.data && (
                    <>
                      <table className="table">
                        <thead>
                          <tr>
                            <th>{t('composer.colStep')}</th>
                            <th>{t('common.status')}</th>
                            <th>{t('composer.colMs')}</th>
                            <th>{t('composer.colResult', { raw: dryRun.data.rawVisible })}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(dryRun.data.steps).map(([id, s]) => (
                            <tr key={id}>
                              <td className="mono">{id}</td>
                              <td>
                                <Badge kind={STEP_STATUS_KIND[s.status] ?? 'error'}>{STEP_STATUS_LABELS[s.status] ? t(STEP_STATUS_LABELS[s.status]!) : s.status}</Badge>
                              </td>
                              <td className="mono">{fmtNumber(s.durationMs)}</td>
                              <td>
                                <JsonView value={s.error ?? s.value} maxHeight={140} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="label">{t('composer.finalOutput')}</div>
                      <JsonView value={dryRun.data.output} />
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {publishing && selected && (
        <PublishWizard
          compositeId={selected.id}
          onClose={() => {
            setPublishing(false);
            void readiness.refetch();
            void invalidate('composites');
          }}
        />
      )}
    </>
  );
}

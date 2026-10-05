import { useMutation } from '@tanstack/react-query';
import { Activity, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { LlmProvider, LlmSettings, LlmTestResult, ObservabilitySettings } from '../api/types';
import { useToast } from '../components/toast';
import { Badge, ErrorBox, Field, fmtDate, PageHeader, Tabs } from '../components/ui';
import { useT } from '../i18n';
import { useInvalidate, useTenantQuery } from '../lib/hooks';

/** Anthropic models offered in the select; any other id can be typed. */
export const ANTHROPIC_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'] as const;
const DEFAULT_MODEL: Record<LlmProvider, string> = { anthropic: 'claude-opus-5-5', openai: '', openai_compatible: '' };

interface Form {
  provider: LlmProvider;
  model: string;
  baseUrl: string;
  jsonMode: 'schema' | 'object';
  maxGenerationsPerHour: number;
  apiKey: string;
  removeKey: boolean;
}

const fromSettings = (s: LlmSettings | undefined): Form => ({
  provider: s?.provider ?? 'anthropic',
  model: s?.model ?? DEFAULT_MODEL.anthropic,
  baseUrl: s?.baseUrl ?? '',
  jsonMode: s?.jsonMode ?? 'schema',
  maxGenerationsPerHour: s?.maxGenerationsPerHour ?? 30,
  apiKey: '',
  removeKey: false,
});

/** Tenant settings (gateway-admin): the Composer LLM provider (ADR-015) and observability (ADR-016). */
export function SettingsPage() {
  const t = useT();
  const [tab, setTab] = useState<'llm' | 'observability'>('llm');
  return (
    <>
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />
      <Tabs<'llm' | 'observability'>
        tabs={[
          { id: 'llm', label: t('settings.tabLlm'), icon: <Sparkles size={20} /> },
          { id: 'observability', label: t('settings.tabObservability'), icon: <Activity size={20} /> },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'llm' ? <LlmSettingsPanel /> : <ObservabilitySettingsPanel />}
    </>
  );
}

const SUBJECT_DETECTORS = ['cpf', 'cnpj', 'pis', 'email', 'telefone'];

/** Observability settings (ADR-016): trace propagation, session id, pricing, subject index and report_outcome. */
function ObservabilitySettingsPanel() {
  const t = useT();
  const toast = useToast();
  const invalidate = useInvalidate();
  const settings = useTenantQuery<ObservabilitySettings>(['settings', 'observability'], '/settings/observability');
  const [form, setForm] = useState<ObservabilitySettings | null>(null);
  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);
  const save = useMutation({
    mutationFn: (body: ObservabilitySettings) => api<ObservabilitySettings>('/settings/observability', { method: 'PUT', body }),
    onSuccess: () => {
      toast('ok', t('settings.saved'));
      void invalidate('settings');
      void invalidate('analytics');
    },
  });
  if (!form) return <div className="content"><ErrorBox error={settings.error} /></div>;
  const set = (patch: Partial<ObservabilitySettings>) => setForm({ ...form, ...patch });
  return (
    <div className="content" style={{ maxWidth: 760 }}>
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">{t('settings.obsPanel')}</span>
        </div>
        <div className="panel-body stack" data-testid="observability-settings">
          <p className="hint" style={{ margin: 0 }}>{t('settings.obsIntro')}</p>
          <label className="check">
            <input type="checkbox" checked={form.tracePropagation.inbound} onChange={(e) => set({ tracePropagation: { ...form.tracePropagation, inbound: e.target.checked } })} /> {t('settings.obsTraceInbound')}
          </label>
          <label className="check">
            <input type="checkbox" checked={form.tracePropagation.outbound} onChange={(e) => set({ tracePropagation: { ...form.tracePropagation, outbound: e.target.checked } })} /> {t('settings.obsTraceOutbound')}
          </label>
          <label className="check">
            <input type="checkbox" checked={form.issueSessionId} onChange={(e) => set({ issueSessionId: e.target.checked })} /> {t('settings.obsIssueSession')}
          </label>
          <div className="grid-2">
            <Field label={t('settings.obsCurrency')}>
              <input className="input mono" maxLength={3} aria-label={t('settings.obsCurrency')} value={form.pricing.currency} onChange={(e) => set({ pricing: { ...form.pricing, currency: e.target.value.toUpperCase() } })} />
            </Field>
            <Field label={t('settings.obsPrice')} hint={t('settings.obsPriceHint')}>
              <input className="input mono" type="number" min={0} step="0.01" aria-label={t('settings.obsPrice')} value={form.pricing.inputPerMTok} onChange={(e) => set({ pricing: { ...form.pricing, inputPerMTok: Number(e.target.value) || 0 } })} />
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={form.subjectIndex.enabled} onChange={(e) => set({ subjectIndex: { ...form.subjectIndex, enabled: e.target.checked } })} /> {t('settings.obsSubjectIndex')}
          </label>
          <Field label={t('settings.obsDetectors')}>
            <div className="row">
              {SUBJECT_DETECTORS.map((d) => (
                <label key={d} className="check">
                  <input
                    type="checkbox"
                    checked={form.subjectIndex.detectors.includes(d)}
                    onChange={(e) =>
                      set({ subjectIndex: { ...form.subjectIndex, detectors: e.target.checked ? [...form.subjectIndex.detectors, d] : form.subjectIndex.detectors.filter((x) => x !== d) } })
                    }
                  />{' '}
                  {d}
                </label>
              ))}
            </div>
          </Field>
          <Field label={t('settings.obsMaxPerCall')}>
            <input className="input mono" type="number" min={1} max={1000} style={{ width: 140 }} aria-label={t('settings.obsMaxPerCall')} value={form.subjectIndex.maxPerCall} onChange={(e) => set({ subjectIndex: { ...form.subjectIndex, maxPerCall: Number(e.target.value) || 1 } })} />
          </Field>
          <Field label={t('settings.obsOutcomeTool')}>
            <select className="select" aria-label={t('settings.obsOutcomeTool')} value={form.outcomeTool} onChange={(e) => set({ outcomeTool: e.target.value as ObservabilitySettings['outcomeTool'] })}>
              <option value="off">{t('settings.obsOutcomeOff')}</option>
              <option value="omni">{t('settings.obsOutcomeOmni')}</option>
              <option value="all">{t('settings.obsOutcomeAll')}</option>
            </select>
          </Field>
          <ErrorBox error={save.error} />
          <div className="row">
            <button className="btn primary" onClick={() => save.mutate(form)} disabled={save.isPending}>
              {t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LlmSettingsPanel() {
  const t = useT();
  const toast = useToast();
  const invalidate = useInvalidate();
  const settings = useTenantQuery<LlmSettings>(['settings', 'llm'], '/settings/llm');
  const [form, setForm] = useState<Form>(fromSettings(undefined));
  const [customModel, setCustomModel] = useState(false);
  const [test, setTest] = useState<LlmTestResult | null>(null);

  useEffect(() => {
    if (!settings.data) return;
    const f = fromSettings(settings.data.configured ? settings.data : undefined);
    setForm(f);
    setCustomModel(f.provider === 'anthropic' && !(ANTHROPIC_MODELS as readonly string[]).includes(f.model));
  }, [settings.data]);

  const s = settings.data;
  const body = () => ({
    provider: form.provider,
    model: form.model.trim(),
    ...(form.provider === 'openai_compatible' ? { baseUrl: form.baseUrl.trim() || null, jsonMode: form.jsonMode } : {}),
    maxGenerationsPerHour: form.maxGenerationsPerHour,
    ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : form.removeKey ? { apiKey: null } : {}),
  });

  const save = useMutation({
    mutationFn: () => api<LlmSettings>('/settings/llm', { method: 'PUT', body: body() }),
    onSuccess: () => {
      toast('ok', t('settings.saved'));
      setTest(null);
      void invalidate('settings');
    },
  });
  const runTest = useMutation({
    mutationFn: () => api<LlmTestResult>('/settings/llm/test', { method: 'POST', body: body() }),
    onSuccess: setTest,
  });
  const remove = useMutation({
    mutationFn: () => api<void>('/settings/llm', { method: 'DELETE' }),
    onSuccess: () => {
      toast('ok', t('settings.deleted'));
      void invalidate('settings');
    },
  });

  const setProvider = (provider: LlmProvider) => {
    setForm({ ...form, provider, model: DEFAULT_MODEL[provider] });
    setCustomModel(false);
  };
  const providerChanged = s?.configured && s.provider !== form.provider;
  const keyStatus = !s?.hasApiKey || providerChanged
    ? t('settings.apiKeyMissing')
    : s.apiKeyHint
      ? t('settings.apiKeyConfigured', { hint: `••••${s.apiKeyHint}` })
      : t('settings.apiKeyConfiguredNoHint');

  return (
    <>
      <div className="content" style={{ maxWidth: 760 }}>
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">{t('settings.llmPanel')}</span>
            <Badge kind={s?.configured ? 'ok' : 'warn'}>{s?.configured ? `${s.provider} · ${s.model}` : t('settings.notConfigured')}</Badge>
          </div>
          <div className="panel-body stack" data-testid="llm-settings">
            <p className="hint" style={{ margin: 0 }}>{t('settings.llmIntro')}</p>
            <ErrorBox error={settings.error} />

            <Field label={t('settings.provider')}>
              <div className="row" role="radiogroup" aria-label={t('settings.provider')}>
                {(
                  [
                    ['anthropic', 'settings.providerAnthropic'],
                    ['openai', 'settings.providerOpenai'],
                    ['openai_compatible', 'settings.providerCompatible'],
                  ] as const
                ).map(([p, label]) => (
                  <label key={p} className="check">
                    <input type="radio" name="provider" checked={form.provider === p} onChange={() => setProvider(p)} /> {t(label)}
                  </label>
                ))}
              </div>
            </Field>

            <Field label={t('settings.model')}>
              {form.provider === 'anthropic' && !customModel ? (
                <select
                  className="select mono"
                  aria-label={t('settings.model')}
                  value={form.model}
                  onChange={(e) => {
                    if (e.target.value === '__other') {
                      setCustomModel(true);
                      setForm({ ...form, model: '' });
                    } else setForm({ ...form, model: e.target.value });
                  }}
                >
                  {ANTHROPIC_MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  <option value="__other">{t('settings.modelOther')}</option>
                </select>
              ) : (
                <input className="input mono" aria-label={t('settings.modelCustom')} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
              )}
            </Field>

            {form.provider === 'openai_compatible' && (
              <div className="grid-2">
                <Field label={t('settings.baseUrl')} hint={t('settings.baseUrlHint')}>
                  <input className="input mono" aria-label={t('settings.baseUrl')} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
                </Field>
                <Field label={t('settings.jsonMode')} hint={t('settings.jsonModeHint')}>
                  <select className="select" aria-label={t('settings.jsonMode')} value={form.jsonMode} onChange={(e) => setForm({ ...form, jsonMode: e.target.value as Form['jsonMode'] })}>
                    <option value="schema">{t('settings.jsonModeSchema')}</option>
                    <option value="object">{t('settings.jsonModeObject')}</option>
                  </select>
                </Field>
              </div>
            )}

            <Field label={t('settings.apiKey')} hint={t('settings.apiKeyHint')}>
              <div className="row">
                <Badge kind={s?.hasApiKey && !providerChanged && !form.removeKey ? 'ok' : 'warn'}>{keyStatus}</Badge>
                {s?.hasApiKey && !providerChanged && (
                  <button className="btn sm ghost" type="button" onClick={() => setForm({ ...form, removeKey: !form.removeKey, apiKey: '' })}>
                    {t('settings.removeKey')}
                  </button>
                )}
              </div>
              <input
                className="input mono"
                type="password"
                autoComplete="off"
                aria-label={t('settings.apiKey')}
                placeholder={t('settings.apiKeyPlaceholder')}
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value, removeKey: false })}
              />
              {form.removeKey && <span className="hint">{t('settings.removeKeyPending')}</span>}
            </Field>

            <Field label={t('settings.maxPerHour')} hint={t('settings.maxPerHourHint')}>
              <input
                className="input mono"
                type="number"
                min={1}
                max={1000}
                style={{ width: 140 }}
                aria-label={t('settings.maxPerHour')}
                value={form.maxGenerationsPerHour}
                onChange={(e) => setForm({ ...form, maxGenerationsPerHour: Number(e.target.value) || 1 })}
              />
            </Field>

            <ErrorBox error={save.error ?? runTest.error ?? remove.error} />
            {test && <div className={`alert ${test.ok ? 'ok' : 'error'}`}>{test.ok ? t('settings.testOk', { ms: test.latencyMs }) : t('settings.testFailed', { error: test.error ?? '' })}</div>}
            <div className="row">
              <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending || !form.model.trim()}>
                {t('common.save')}
              </button>
              <button className="btn" onClick={() => runTest.mutate()} disabled={runTest.isPending || !form.model.trim()}>
                {t('settings.test')}
              </button>
              {s?.configured && (
                <button className="btn ghost" onClick={() => confirm(t('settings.deleteConfirm')) && remove.mutate()} disabled={remove.isPending}>
                  {t('settings.deleteConfig')}
                </button>
              )}
            </div>
            {s?.configured && s.updatedAt && <span className="hint">{t('settings.lastUpdate', { user: s.updatedBy ?? '—', date: fmtDate(s.updatedAt) })}</span>}
          </div>
        </div>
      </div>
    </>
  );
}

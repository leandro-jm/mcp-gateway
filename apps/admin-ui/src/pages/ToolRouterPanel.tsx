import { useMutation } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { DecisionProvider, DecisionProviderDto, LlmTestResult, ToolRouterSettings, ToolRouterView } from '../api/types';
import { useToast } from '../components/toast';
import { Badge, ErrorBox, Field, fmtDate } from '../components/ui';
import { useT } from '../i18n';
import { useInvalidate, useTenantQuery } from '../lib/hooks';

const DEFAULT_MODEL: Record<DecisionProvider, string> = { openai_decisions: 'gpt-6-luna', jev: 'jev-latest' };

interface ProviderForm {
  provider: DecisionProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
  removeKey: boolean;
}

const fromDto = (p: DecisionProviderDto | undefined): ProviderForm => ({
  provider: p?.provider ?? 'openai_decisions',
  model: p?.model ?? '',
  baseUrl: p?.baseUrl ?? '',
  apiKey: '',
  removeKey: false,
});

/** Decision-model tool router (ADR-025): provider card and behavior card (master switch, per-point switches). */
export function ToolRouterPanel() {
  const t = useT();
  const view = useTenantQuery<ToolRouterView>(['settings', 'tool-router'], '/settings/tool-router');
  return (
    <div className="content stack" style={{ maxWidth: 820 }}>
      <ErrorBox error={view.error} />
      {view.data && (
        <>
          {!view.data.platformEnabled && <div className="alert warn">{t('router.platformOff')}</div>}
          <ProviderCard provider={view.data.provider} />
          <BehaviorCard settings={view.data.settings} hasKey={Boolean(view.data.provider.hasApiKey)} readOnly={!view.data.platformEnabled} />
        </>
      )}
    </div>
  );
}

function ProviderCard({ provider: p }: { provider: DecisionProviderDto }) {
  const t = useT();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [form, setForm] = useState<ProviderForm>(fromDto(p.configured ? p : undefined));
  const [test, setTest] = useState<LlmTestResult | null>(null);
  useEffect(() => setForm(fromDto(p.configured ? p : undefined)), [p]);

  const body = () => ({
    provider: form.provider,
    ...(form.model.trim() ? { model: form.model.trim() } : {}),
    baseUrl: form.baseUrl.trim() || null,
    ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : form.removeKey ? { apiKey: null } : {}),
  });
  const save = useMutation({
    mutationFn: () => api<DecisionProviderDto>('/settings/tool-router/provider', { method: 'PUT', body: body() }),
    onSuccess: () => {
      toast('ok', t('settings.saved'));
      setTest(null);
      void invalidate('settings');
    },
  });
  const runTest = useMutation({
    mutationFn: () => api<LlmTestResult>('/settings/tool-router/test', { method: 'POST', body: body() }),
    onSuccess: setTest,
  });
  const remove = useMutation({
    mutationFn: () => api<void>('/settings/tool-router/provider', { method: 'DELETE' }),
    onSuccess: () => {
      toast('ok', t('settings.deleted'));
      void invalidate('settings');
    },
  });

  const providerChanged = p.configured && p.provider !== form.provider;
  const keyOk = p.hasApiKey && !providerChanged && !form.removeKey;
  const keyStatus = !keyOk
    ? t('settings.apiKeyMissing')
    : p.apiKeyHint
      ? t('settings.apiKeyConfigured', { hint: `••••${p.apiKeyHint}` })
      : t('settings.apiKeyConfiguredNoHint');

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">{t('router.providerPanel')}</span>
        <Badge kind={p.configured ? 'ok' : 'warn'}>{p.configured ? `${p.provider} · ${p.model}` : t('settings.notConfigured')}</Badge>
      </div>
      <div className="panel-body stack" data-testid="router-provider">
        <p className="hint" style={{ margin: 0 }}>{t('router.providerIntro')}</p>
        <Field label={t('settings.provider')}>
          <div className="row" role="radiogroup" aria-label={t('settings.provider')}>
            <label className="check">
              <input type="radio" name="decision-provider" checked={form.provider === 'openai_decisions'} onChange={() => setForm({ ...form, provider: 'openai_decisions', model: '' })} /> {t('router.providerOpenai')}
            </label>
            <label className="check">
              <input type="radio" name="decision-provider" checked={form.provider === 'jev'} onChange={() => setForm({ ...form, provider: 'jev', model: '' })} /> {t('router.providerJev')}{' '}
              <Badge kind="warn">{t('router.experimental')}</Badge>
            </label>
          </div>
        </Field>
        <div className="grid-2">
          <Field label={t('router.model')} hint={t('router.modelHint', { model: DEFAULT_MODEL[form.provider] })}>
            <input className="input mono" aria-label={t('router.model')} placeholder={DEFAULT_MODEL[form.provider]} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
          </Field>
          <Field label={t('router.baseUrl')} hint={t('router.baseUrlHint')}>
            <input className="input mono" aria-label={t('router.baseUrl')} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
          </Field>
        </div>
        <Field label={t('settings.apiKey')} hint={t('settings.apiKeyHint')}>
          <div className="row">
            <Badge kind={keyOk ? 'ok' : 'warn'}>{keyStatus}</Badge>
            {p.hasApiKey && !providerChanged && (
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
        <ErrorBox error={save.error ?? runTest.error ?? remove.error} />
        {test && <div className={`alert ${test.ok ? 'ok' : 'error'}`}>{test.ok ? t('settings.testOk', { ms: test.latencyMs }) : t('settings.testFailed', { error: test.error ?? '' })}</div>}
        <div className="row">
          <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {t('router.saveProvider')}
          </button>
          <button className="btn" onClick={() => runTest.mutate()} disabled={runTest.isPending}>
            {t('settings.test')}
          </button>
          {p.configured && (
            <button className="btn ghost" onClick={() => confirm(t('router.removeConfirm')) && remove.mutate()} disabled={remove.isPending}>
              {t('router.removeProvider')}
            </button>
          )}
        </div>
        {p.configured && p.updatedAt && <span className="hint">{t('settings.lastUpdate', { user: p.updatedBy ?? '—', date: fmtDate(p.updatedAt) })}</span>}
      </div>
    </div>
  );
}

/** Number input bound to one setting. */
function Num({ label, value, onChange, step = 1, min, max, disabled }: { label: string; value: number; onChange: (n: number) => void; step?: number; min?: number; max?: number; disabled?: boolean }) {
  return (
    <Field label={label}>
      <input className="input mono" type="number" step={step} min={min} max={max} aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
    </Field>
  );
}

function Point({ title, hint, enabled, onToggle, disabled, children }: { title: string; hint: string; enabled: boolean; onToggle: (on: boolean) => void; disabled: boolean; children: ReactNode }) {
  return (
    <fieldset className="stack" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }} disabled={disabled}>
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} /> <strong>{title}</strong>
      </label>
      <span className="hint">{hint}</span>
      {enabled && <div className="grid-2">{children}</div>}
    </fieldset>
  );
}

function BehaviorCard({ settings, hasKey, readOnly }: { settings: ToolRouterSettings; hasKey: boolean; readOnly: boolean }) {
  const t = useT();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [form, setForm] = useState<ToolRouterSettings>(settings);
  useEffect(() => setForm(settings), [settings]);
  const save = useMutation({
    mutationFn: (body: ToolRouterSettings) => api<ToolRouterView>('/settings/tool-router', { method: 'PUT', body }),
    onSuccess: () => {
      toast('ok', t('settings.saved'));
      void invalidate('settings');
    },
  });
  const rerank = (patch: Partial<ToolRouterSettings['rerank']>) => setForm({ ...form, rerank: { ...form.rerank, ...patch } });
  const shortlist = (patch: Partial<ToolRouterSettings['shortlist']>) => setForm({ ...form, shortlist: { ...form.shortlist, ...patch } });
  const gate = (patch: Partial<ToolRouterSettings['gate']>) => setForm({ ...form, gate: { ...form.gate, ...patch } });
  const off = readOnly || !form.enabled;

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">{t('router.behaviorPanel')}</span>
        <Badge kind={settings.enabled && !readOnly ? 'ok' : 'warn'}>{settings.enabled && !readOnly ? t('router.statusOn') : t('router.statusOff')}</Badge>
      </div>
      <div className="panel-body stack" data-testid="router-behavior">
        <label className="check">
          <input type="checkbox" checked={form.enabled} disabled={readOnly || (!hasKey && !form.enabled)} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> <strong>{t('router.enabled')}</strong>
        </label>
        <span className="hint">{t('router.enabledHint')}</span>
        <div className="alert warn">{t('router.dataNotice')}</div>

        <Point title={t('router.rerank')} hint={t('router.rerankHint')} enabled={form.rerank.enabled} onToggle={(enabled) => rerank({ enabled })} disabled={off}>
          <Num label={t('router.candidates')} value={form.rerank.candidates} min={5} max={50} onChange={(candidates) => rerank({ candidates })} />
          <Num label={t('router.minConfidence')} value={form.rerank.minConfidence} step={0.05} min={0} max={1} onChange={(minConfidence) => rerank({ minConfidence })} />
          <Num label={t('router.timeoutMs')} value={form.rerank.timeoutMs} step={100} min={100} max={5000} onChange={(timeoutMs) => rerank({ timeoutMs })} />
        </Point>

        <Point title={t('router.shortlist')} hint={t('router.shortlistHint')} enabled={form.shortlist.enabled} onToggle={(enabled) => shortlist({ enabled })} disabled={off}>
          <Field label={t('router.granularity')}>
            <select className="select" aria-label={t('router.granularity')} value={form.shortlist.granularity} onChange={(e) => shortlist({ granularity: e.target.value as ToolRouterSettings['shortlist']['granularity'] })}>
              <option value="namespace">{t('router.granularityNamespace')}</option>
              <option value="tool">{t('router.granularityTool')}</option>
            </select>
          </Field>
          <Num label={t('router.mass')} value={form.shortlist.mass} step={0.05} min={0.5} max={1} onChange={(mass) => shortlist({ mass })} />
          <Num label={t('router.maxNamespaces')} value={form.shortlist.maxNamespaces} min={1} max={10} onChange={(maxNamespaces) => shortlist({ maxNamespaces })} />
          <Num label={t('router.minTools')} value={form.shortlist.minTools} min={1} max={50} onChange={(minTools) => shortlist({ minTools })} />
          <Num label={t('router.maxTools')} value={form.shortlist.maxTools} min={1} max={200} onChange={(maxTools) => shortlist({ maxTools })} />
          <Num label={t('router.timeoutMs')} value={form.shortlist.timeoutMs} step={100} min={100} max={5000} onChange={(timeoutMs) => shortlist({ timeoutMs })} />
        </Point>

        <Point title={t('router.gate')} hint={t('router.gateHint')} enabled={form.gate.enabled} onToggle={(enabled) => gate({ enabled })} disabled={off}>
          <Field label={t('router.scope')}>
            <select className="select" aria-label={t('router.scope')} value={form.gate.scope} onChange={(e) => gate({ scope: e.target.value as ToolRouterSettings['gate']['scope'] })}>
              <option value="non-readonly">{t('router.scopeNonReadonly')}</option>
              <option value="destructive">{t('router.scopeDestructive')}</option>
              <option value="all">{t('router.scopeAll')}</option>
            </select>
          </Field>
          <Field label={t('router.argsMode')}>
            <select className="select" aria-label={t('router.argsMode')} value={form.gate.argsMode} onChange={(e) => gate({ argsMode: e.target.value as ToolRouterSettings['gate']['argsMode'] })}>
              <option value="redacted">{t('router.argsRedacted')}</option>
              <option value="none">{t('router.argsNone')}</option>
            </select>
          </Field>
          <Num label={t('router.confirmAt')} value={form.gate.confirmAt} step={0.05} min={0} max={1} onChange={(confirmAt) => gate({ confirmAt })} />
          <Num label={t('router.denyAt')} value={form.gate.denyAt} step={0.05} min={0} max={1} onChange={(denyAt) => gate({ denyAt })} />
          <Field label={t('router.onError')}>
            <select className="select" aria-label={t('router.onError')} value={form.gate.onError} onChange={(e) => gate({ onError: e.target.value as ToolRouterSettings['gate']['onError'] })}>
              <option value="allow">{t('router.onErrorAllow')}</option>
              <option value="deny">{t('router.onErrorDeny')}</option>
            </select>
          </Field>
          <Field label={t('router.onConfirm')}>
            <select className="select" aria-label={t('router.onConfirm')} value={form.gate.onConfirmWithoutUi} onChange={(e) => gate({ onConfirmWithoutUi: e.target.value as ToolRouterSettings['gate']['onConfirmWithoutUi'] })}>
              <option value="deny">{t('router.onConfirmDeny')}</option>
              <option value="allow">{t('router.onConfirmAllow')}</option>
            </select>
          </Field>
          <Num label={t('router.timeoutMs')} value={form.gate.timeoutMs} step={100} min={100} max={5000} onChange={(timeoutMs) => gate({ timeoutMs })} />
        </Point>

        <div className="grid-2">
          <Num label={t('router.maxPerMinute')} value={form.maxDecisionsPerMinute} min={1} max={100000} disabled={readOnly} onChange={(maxDecisionsPerMinute) => setForm({ ...form, maxDecisionsPerMinute })} />
          <Field label={t('router.cacheTtl')} hint={t('router.cacheTtlHint')}>
            <input className="input mono" type="number" min={0} max={86400} aria-label={t('router.cacheTtl')} value={form.cacheTtlSeconds} disabled={readOnly} onChange={(e) => setForm({ ...form, cacheTtlSeconds: Number(e.target.value) })} />
          </Field>
        </div>

        <ErrorBox error={save.error} />
        <div className="row">
          <button className="btn primary" onClick={() => save.mutate(form)} disabled={save.isPending || readOnly}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

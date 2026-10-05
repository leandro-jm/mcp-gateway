import { useMutation } from '@tanstack/react-query';
import { Eye, List, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import { useSession } from '../api/session';
import type { PiiRule } from '../api/types';
import { Editor } from '../components/Editor';
import { useToast } from '../components/toast';
import { Badge, ErrorBox, Field, fmtNumber, JsonView, PageHeader, Tabs } from '../components/ui';
import { useT, type UiMessageKey } from '../i18n';
import { useInvalidate, useTenantQuery } from '../lib/hooks';
import { parseJson } from '../lib/schema';

type Tab = 'rules' | 'preview';

const SCOPE_LABELS: Record<PiiRule['scope'], UiMessageKey> = { global: 'pii.scopeGlobal', source: 'pii.scopeSource', tool: 'pii.scopeTool' };
const STRATEGY_LABELS: Record<PiiRule['strategy'], UiMessageKey> = {
  mask: 'pii.strategyMask',
  hash: 'pii.strategyHash',
  drop: 'pii.strategyDrop',
  tokenize: 'pii.strategyTokenize',
};
const DIRECTION_LABELS: Record<PiiRule['direction'], UiMessageKey> = { both: 'pii.directionBoth', response: 'pii.directionResponse', request: 'pii.directionRequest' };

const SAMPLE = {
  items: [
    { id: 'col-1', nome: 'Ana Souza', cpf: '529.982.247-25', email: 'ana@empresa.com', telefone: '(11) 98765-4321', salario: 5380.38, data_nascimento: '1990-01-01', observacao: 'contato: ana@empresa.com' },
  ],
};

export function PiiPage() {
  const t = useT();
  const { me } = useSession();
  const [tab, setTab] = useState<Tab>('rules');
  const rules = useTenantQuery<{ items: PiiRule[] }>(['pii-rules'], '/pii-rules');
  const detectors = useTenantQuery<{ items: Array<{ id: string; category: string; kind: string }> }>(['pii-detectors'], '/pii-detectors');
  const invalidate = useInvalidate();
  const toast = useToast();
  const [form, setForm] = useState({ scope: 'global', scopeRef: '', detector: 'cpf', fieldSelector: '', strategy: 'mask', direction: 'both' });
  const create = useMutation({
    mutationFn: () => api('/pii-rules', { method: 'POST', body: { ...form, scopeRef: form.scopeRef || null, fieldSelector: form.fieldSelector || null } }),
    onSuccess: () => {
      toast('ok', t('pii.saved'));
      void invalidate('pii-rules');
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => api(`/pii-rules/${id}`, { method: 'DELETE' }), onSuccess: () => void invalidate('pii-rules') });
  const [payload, setPayload] = useState(JSON.stringify(SAMPLE, null, 2));
  const preview = useMutation({
    mutationFn: () => {
      const p = parseJson(payload);
      if (p.error) throw new Error(t('common.invalidPayload', { error: p.error }));
      return api<{ redacted: unknown; count: number; byDetector: Record<string, number> }>('/pii-rules/preview', { method: 'POST', body: { payload: p.value } });
    },
  });
  const ids = [...new Set((detectors.data?.items ?? []).map((d) => d.id)), 'field'];
  return (
    <>
      <PageHeader title={t('pii.title')} subtitle={t('pii.subtitle')} />
      <Tabs<Tab>
        tabs={[
          { id: 'rules', label: t('pii.tabRules'), icon: <List size={20} /> },
          { id: 'preview', label: t('pii.tabPreview'), icon: <Eye size={20} /> },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="content stack">
        {tab === 'rules' && (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('pii.colDetector')}</th>
                  <th>{t('pii.colScope')}</th>
                  <th>{t('pii.colField')}</th>
                  <th>{t('pii.colStrategy')}</th>
                  <th>{t('pii.colDirection')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(rules.data?.items ?? []).map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.detector}</td>
                    <td>
                      <Badge>{t(SCOPE_LABELS[r.scope])}</Badge> <span className="mono dim">{r.scopeRef?.slice(0, 8) ?? ''}</span>
                    </td>
                    <td className="mono muted">{r.fieldSelector ?? '—'}</td>
                    <td>
                      <Badge kind="accent">{t(STRATEGY_LABELS[r.strategy])}</Badge>
                    </td>
                    <td className="muted">{t(DIRECTION_LABELS[r.direction])}</td>
                    <td>
                      {me.isAdmin && (
                        <button className="btn sm ghost" aria-label={t('common.remove')} onClick={() => remove.mutate(r.id)}>
                          <Trash2 size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {me.isAdmin && (
              <div className="panel">
                <div className="panel-head">
                  <span className="panel-title">{t('pii.newRule')}</span>
                </div>
                <div className="panel-body">
                  <div className="grid-2">
                    <Field label={t('pii.colDetector')}>
                      <select className="select" value={form.detector} onChange={(e) => setForm({ ...form, detector: e.target.value })}>
                        {ids.map((d) => (
                          <option key={d}>{d}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label={t('pii.colStrategy')}>
                      <select className="select" value={form.strategy} onChange={(e) => setForm({ ...form, strategy: e.target.value })}>
                        {Object.entries(STRATEGY_LABELS).map(([d, key]) => (
                          <option key={d} value={d}>
                            {t(key)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={t('pii.colScope')}>
                      <select className="select" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}>
                        {Object.entries(SCOPE_LABELS).map(([d, key]) => (
                          <option key={d} value={d}>
                            {t(key)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={t('pii.scopeRef')}>
                      <input className="input mono" value={form.scopeRef} onChange={(e) => setForm({ ...form, scopeRef: e.target.value })} />
                    </Field>
                    <Field label={t('pii.fieldSelector')} hint={t('pii.fieldSelectorHint', { example: '$.items[*].cpf' })}>
                      <input className="input mono" value={form.fieldSelector} onChange={(e) => setForm({ ...form, fieldSelector: e.target.value })} />
                    </Field>
                    <Field label={t('pii.colDirection')}>
                      <select className="select" value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
                        {Object.entries(DIRECTION_LABELS).map(([d, key]) => (
                          <option key={d} value={d}>
                            {t(key)}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <ErrorBox error={create.error} />
                  <button className="btn primary" onClick={() => create.mutate()} disabled={create.isPending}>
                    {t('pii.saveRule')}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        {tab === 'preview' && (
          <>
            <div className="split panel">
              <div className="panel-body">
                <div className="label" style={{ marginBottom: 8 }}>
                  {t('pii.samplePayload')}
                </div>
                <Editor value={payload} onChange={setPayload} height="360px" />
              </div>
              <div className="panel-body">
                <div className="label" style={{ marginBottom: 8 }}>
                  {t('pii.output')}
                </div>
                {preview.data ? <JsonView value={preview.data.redacted} maxHeight={360} /> : <p className="muted">{t('pii.clickApply')}</p>}
              </div>
            </div>
            <div className="row">
              <button className="btn primary" onClick={() => preview.mutate()} disabled={preview.isPending}>
                {t('pii.applyRules')}
              </button>
              {preview.data && (
                <div className="chips">
                  <Badge kind="accent">{t('common.redactions', { count: preview.data.count })}</Badge>
                  {Object.entries(preview.data.byDetector).map(([k, v]) => (
                    <Badge key={k}>
                      {k} × {fmtNumber(v)}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
            <ErrorBox error={preview.error} />
          </>
        )}
      </div>
    </>
  );
}

import { useMutation } from '@tanstack/react-query';
import { ClipboardPaste, FileUp, Link } from 'lucide-react';
import { useMemo, useState, type DragEvent } from 'react';
import { api } from '../api/client';
import type { Credential, ImportFormat, ImportInput, ImportPreview, ImportResult, Source } from '../api/types';
import { useT, type UiMessageKey } from '../i18n';
import { useInvalidate } from '../lib/hooks';
import { useToast } from './toast';
import { Badge, Drawer, ErrorBox, Field, fmtBytes, JsonView, Tabs } from './ui';

type Step = 'input' | 'preview' | 'target';
type InputTab = 'paste' | 'file' | 'url';

export const FORMAT_LABEL: Record<ImportFormat, UiMessageKey> = {
  openapi: 'import.formatOpenapi',
  curl: 'import.formatCurl',
  postman: 'import.formatPostman',
  har: 'import.formatHar',
};

const STATUS_LABEL: Record<ImportPreview['operations'][number]['status'], UiMessageKey> = {
  new: 'import.statusNew',
  unchanged: 'import.statusUnchanged',
  conflict: 'import.statusConflict',
};

/** Cosmetic format hint while typing; the gateway does the real detection. */
function sniffFormat(text: string): ImportFormat | null {
  const head = text.slice(0, 5000);
  if (/^\s*(\$\s+)?curl(\.exe)?\s/i.test(head)) return 'curl';
  if (/"_postman_id"|schema\.getpostman\.com/.test(head)) return 'postman';
  if (/"log"\s*:\s*\{/.test(head)) return 'har';
  if (/^\s*\{?\s*["']?(openapi|swagger)["']?\s*:/m.test(head)) return 'openapi';
  return null;
}

/** "Import API" wizard: input → preview (operation selection) → destination (ADR-014). */
export function ImportWizard({ credentials, sources, onClose, onImported }: { credentials: Credential[]; sources: Source[]; onClose(): void; onImported(source: Source): void }) {
  const t = useT();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [step, setStep] = useState<Step>('input');
  const [tab, setTab] = useState<InputTab>('paste');
  const [text, setText] = useState('');
  const [file, setFile] = useState<{ name: string; size: number; text: string } | null>(null);
  const [url, setUrl] = useState('');
  const [urlCredential, setUrlCredential] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [targetKind, setTargetKind] = useState<'new' | 'existing'>('new');
  const [form, setForm] = useState({ name: '', baseUrl: '', credentialId: '', ownerTeam: '', crawlSchedule: '' });
  const [existingId, setExistingId] = useState('');
  const [mode, setMode] = useState<'add' | 'replace'>('add');
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const input: ImportInput | null =
    tab === 'url' ? (url.trim() ? { kind: 'url', url: url.trim(), credentialId: urlCredential || null } : null) : tab === 'file' ? (file ? { kind: 'text', text: file.text } : null) : text.trim() ? { kind: 'text', text } : null;
  const detected = useMemo(() => (tab === 'paste' ? sniffFormat(text) : tab === 'file' && file ? sniffFormat(file.text) : null), [tab, text, file]);
  const inlineSources = sources.filter((s) => s.hasInlineSpec);

  const preview = useMutation({
    mutationFn: () => api<ImportPreview>('/sources/import/preview', { method: 'POST', body: { input } }),
    onSuccess: (p) => {
      setSelected(new Set(p.operations.filter((o) => !o.skipped).map((o) => o.key)));
      setForm((f) => ({ ...f, name: f.name || p.suggestedName || '', baseUrl: f.baseUrl || p.baseUrlCandidates[0] || '' }));
      setStep('preview');
    },
  });
  const data = preview.data;
  const include = data && selected.size < data.operations.length ? [...selected] : undefined;

  // comparison against the chosen existing source (new / conflict / unchanged)
  const compare = useMutation({
    mutationFn: (sourceId: string) => api<ImportPreview>('/sources/import/preview', { method: 'POST', body: { input, targetSourceId: sourceId, ...(include ? { include } : {}) } }),
  });
  const chooseExisting = (id: string) => {
    setExistingId(id);
    if (id) compare.mutate(id);
    else compare.reset();
  };
  const counts = compare.data?.operations.reduce((acc, o) => ({ ...acc, [o.status]: (acc[o.status] ?? 0) + 1 }), {} as Record<string, number>);

  const submit = useMutation({
    mutationFn: () =>
      api<ImportResult>('/sources/import', {
        method: 'POST',
        body: {
          input,
          ...(include ? { include } : {}),
          target:
            targetKind === 'new'
              ? {
                  kind: 'new',
                  name: form.name,
                  baseUrl: form.baseUrl,
                  credentialId: form.credentialId || null,
                  ownerTeam: form.ownerTeam || null,
                  crawlSchedule: form.crawlSchedule || null,
                }
              : { kind: 'existing', sourceId: existingId, mode },
        },
      }),
    onSuccess: (r) => {
      toast('ok', t('import.done', { count: r.added.length + r.replaced.length }));
      void invalidate('sources');
      onImported(r.source);
    },
  });

  const readFile = async (f: File | undefined) => {
    if (f) setFile({ name: f.name, size: f.size, text: await f.text() });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    void readFile(e.dataTransfer.files[0]);
  };
  const toggle = (key: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const selectable = data?.operations.filter((o) => !o.skipped) ?? [];

  return (
    <Drawer title={t('import.title')} subtitle={<span className="muted">{t(step === 'input' ? 'import.stepInput' : step === 'preview' ? 'import.stepPreview' : 'import.stepTarget')}</span>} onClose={onClose}>
      <div className="drawer-body stack" data-testid="import-wizard">
        {step === 'input' && (
          <>
            <Tabs<InputTab>
              tabs={[
                { id: 'paste', label: t('import.tabPaste'), icon: <ClipboardPaste size={18} /> },
                { id: 'file', label: t('import.tabFile'), icon: <FileUp size={18} /> },
                { id: 'url', label: t('import.tabUrl'), icon: <Link size={18} /> },
              ]}
              value={tab}
              onChange={setTab}
            />
            {tab === 'paste' && (
              <Field label={t('import.pasteLabel')}>
                <textarea className="textarea mono" rows={16} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('import.pastePlaceholder')} aria-label={t('import.pasteLabel')} />
              </Field>
            )}
            {tab === 'file' && (
              <label onDragOver={(e) => e.preventDefault()} onDrop={onDrop} style={{ display: 'block', border: '1px dashed var(--border)', padding: 24, textAlign: 'center', cursor: 'pointer' }}>
                <input type="file" accept=".json,.har,.yaml,.yml,.txt,.sh" hidden onChange={(e) => void readFile(e.target.files?.[0])} aria-label={t('import.tabFile')} />
                <FileUp size={22} />
                <div className="muted">{file ? t('import.fileChosen', { name: file.name, size: fmtBytes(file.size) }) : t('import.fileDrop')}</div>
              </label>
            )}
            {tab === 'url' && (
              <>
                <Field label={t('import.urlLabel')} hint={t('import.urlHint')}>
                  <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} aria-label={t('import.urlLabel')} />
                </Field>
                <Field label={t('import.urlCredential')}>
                  <select className="select" value={urlCredential} onChange={(e) => setUrlCredential(e.target.value)} aria-label={t('import.urlCredential')}>
                    <option value="">{t('common.none')}</option>
                    {credentials.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.type})
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            )}
            {tab !== 'url' && (
              <div className="muted" data-testid="import-detected">
                {detected ? t('import.detected', { format: t(FORMAT_LABEL[detected]) }) : t('import.notDetected')}
              </div>
            )}
            <div className="alert">{t('import.secretsNote')}</div>
            <ErrorBox error={preview.error} />
            <div className="row">
              <button className="btn primary" disabled={!input || preview.isPending} onClick={() => preview.mutate()}>
                {t('import.preview')}
              </button>
            </div>
          </>
        )}

        {step === 'preview' && data && (
          <>
            <div className="row">
              <Badge kind="accent">{t(FORMAT_LABEL[data.format])}</Badge>
              <span className="muted">{t('import.summary', { format: t(FORMAT_LABEL[data.format]), version: data.specVersion, count: data.operations.length })}</span>
            </div>
            {data.warnings.length > 0 && (
              <div className="alert warn" data-testid="import-warnings">
                <strong>{t('import.warnings')}</strong>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {data.warnings.map((w, i) => (
                    <li key={i}>{w.message}</li>
                  ))}
                </ul>
              </div>
            )}
            <table className="table" data-testid="import-operations">
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    <input
                      type="checkbox"
                      aria-label={t('import.selectAll')}
                      checked={selectable.length > 0 && selected.size === selectable.length}
                      onChange={(e) => setSelected(new Set(e.target.checked ? selectable.map((o) => o.key) : []))}
                    />
                  </th>
                  <th>{t('import.operation')}</th>
                  <th>{t('import.toolName')}</th>
                  <th>{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {data.operations.map((o) => {
                  const tool = data.tools.find((x) => x.operationKey === o.key);
                  return [
                    <tr key={o.key} className="clickable" onClick={() => setExpanded(expanded === o.key ? null : o.key)}>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" disabled={!!o.skipped} checked={selected.has(o.key)} onChange={() => toggle(o.key)} aria-label={o.key} />
                      </td>
                      <td>
                        <div className="mono">{o.key}</div>
                        {o.summary && <div className="muted">{o.summary}</div>}
                      </td>
                      <td className="mono muted">{o.toolName ?? '—'}</td>
                      <td>{o.skipped ? <Badge kind="warn">{t('import.skipped', { reason: o.skipped })}</Badge> : <Badge>{t(STATUS_LABEL[o.status])}</Badge>}</td>
                    </tr>,
                    expanded === o.key && tool ? (
                      <tr key={`${o.key}-schema`}>
                        <td />
                        <td colSpan={3}>
                          <div className="label">{t('import.inputSchema')}</div>
                          <JsonView value={tool.inputSchema} maxHeight={260} />
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
            <div className="row">
              <button className="btn" onClick={() => setStep('input')}>
                {t('import.back')}
              </button>
              <span className="muted">{t('import.selected', { count: selected.size })}</span>
              <span className="spacer" />
              <button className="btn primary" disabled={selected.size === 0} onClick={() => setStep('target')}>
                {t('import.next')}
              </button>
            </div>
          </>
        )}

        {step === 'target' && data && (
          <>
            <div className="row">
              <label>
                <input type="radio" name="target" checked={targetKind === 'new'} onChange={() => setTargetKind('new')} /> {t('import.targetNew')}
              </label>
              <label>
                <input type="radio" name="target" checked={targetKind === 'existing'} onChange={() => setTargetKind('existing')} /> {t('import.targetExisting')}
              </label>
            </div>
            {targetKind === 'new' ? (
              <>
                <Field label={t('common.name')} hint={t('sources.nameHint')}>
                  <input className="input mono" value={form.name} onChange={set('name')} aria-label={t('common.name')} />
                </Field>
                <Field label={t('sources.baseUrl')} hint={data.format === 'openapi' ? undefined : t('import.baseUrlHint')}>
                  <input className="input mono" value={form.baseUrl} onChange={set('baseUrl')} aria-label={t('sources.baseUrl')} list="import-base-urls" />
                  <datalist id="import-base-urls">
                    {data.baseUrlCandidates.map((u) => (
                      <option key={u} value={u} />
                    ))}
                  </datalist>
                </Field>
                <div className="grid-2">
                  <Field label={t('sources.credential')} hint={data.suggestedCredential ? t('import.suggestedCredential', { type: data.suggestedCredential.type }) : undefined}>
                    <select className="select" value={form.credentialId} onChange={set('credentialId')} aria-label={t('sources.credential')}>
                      <option value="">{t('common.none')}</option>
                      {credentials.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.type})
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('common.ownerTeam')}>
                    <input className="input" value={form.ownerTeam} onChange={set('ownerTeam')} aria-label={t('common.ownerTeam')} />
                  </Field>
                </div>
                <Field label={t('sources.scheduleCron')} hint={t('common.example', { example: '"0 */6 * * *"' })}>
                  <input className="input mono" value={form.crawlSchedule} onChange={set('crawlSchedule')} aria-label={t('sources.scheduleCron')} />
                </Field>
              </>
            ) : inlineSources.length === 0 ? (
              <div className="alert">{t('import.noInlineSources')}</div>
            ) : (
              <>
                <Field label={t('import.source')} hint={t('import.existingHint')}>
                  <select className="select" value={existingId} onChange={(e) => chooseExisting(e.target.value)} aria-label={t('import.source')}>
                    <option value="" />
                    {inlineSources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('import.mode')}>
                  <div className="row">
                    <label>
                      <input type="radio" name="mode" checked={mode === 'add'} onChange={() => setMode('add')} /> {t('import.modeAdd')}
                    </label>
                    <label>
                      <input type="radio" name="mode" checked={mode === 'replace'} onChange={() => setMode('replace')} /> {t('import.modeReplace')}
                    </label>
                  </div>
                </Field>
                {counts && (
                  <div className="muted" data-testid="import-compare">
                    {t('import.compare', { added: counts.new ?? 0, conflicts: counts.conflict ?? 0, unchanged: counts.unchanged ?? 0 })}
                  </div>
                )}
                <ErrorBox error={compare.error} />
              </>
            )}
            <ErrorBox error={submit.error} />
            <div className="row">
              <button className="btn" onClick={() => setStep('preview')}>
                {t('import.back')}
              </button>
              <span className="spacer" />
              <button
                className="btn primary"
                disabled={submit.isPending || (targetKind === 'new' ? !form.name || !form.baseUrl : !existingId)}
                onClick={() => submit.mutate()}
              >
                {t('import.submit')}
              </button>
            </div>
          </>
        )}
      </div>
    </Drawer>
  );
}

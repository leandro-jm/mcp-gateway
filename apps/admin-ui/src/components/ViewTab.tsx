import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useSession } from '../api/session';
import type { PlaygroundResult, Tool, ToolViewDto } from '../api/types';
import { useT } from '../i18n';
import { useInvalidate } from '../lib/hooks';
import { argsSkeleton, parseJson } from '../lib/schema';
import { Editor } from './Editor';
import { useToast } from './toast';
import { ToolUiPreview } from './ToolUiPreview';
import { ErrorBox, Field } from './ui';

type Status = ToolViewDto['status'];

/** Views of a tool (ADR-022): edit the ViewSpec, start from a suggestion, preview it for real. */
export function ViewTab({ tool }: { tool: Tool }) {
  const t = useT();
  const { tenant, me } = useSession();
  const invalidate = useInvalidate();
  const toast = useToast();
  const current = useQuery({
    queryKey: [tenant, 'view', tool.id],
    queryFn: async () => {
      try {
        return await api<ToolViewDto>(`/tools/${tool.id}/view`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
  });
  const [spec, setSpec] = useState('');
  const [status, setStatus] = useState<Status>('active');
  const [loaded, setLoaded] = useState(false);
  const [sampleArgs, setSampleArgs] = useState(JSON.stringify(argsSkeleton(tool.inputSchema), null, 2));
  useEffect(() => {
    const v = current.data;
    if (v === undefined || loaded) return;
    if (v) {
      setSpec(JSON.stringify(v.views, null, 2));
      setStatus(v.status);
    }
    setLoaded(true);
  }, [current.data, loaded]);

  const suggest = useMutation({
    mutationFn: () => api<{ views: Record<string, unknown> }>(`/tools/${tool.id}/view/suggest`, { method: 'POST' }),
    onSuccess: (r) => setSpec(JSON.stringify(r.views, null, 2)),
  });
  const save = useMutation({
    mutationFn: () => {
      const v = parseJson<Record<string, unknown>>(spec);
      if (v.error) throw new Error(v.error);
      return api<ToolViewDto>(`/tools/${tool.id}/view`, { method: 'PUT', body: { views: v.value, status } });
    },
    onSuccess: () => {
      toast('ok', t('views.saved'));
      void invalidate('view', tool.id);
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/tools/${tool.id}/view`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('ok', t('views.removed'));
      setSpec('');
      void invalidate('view', tool.id);
    },
  });
  const subject = { sub: me.sub, roles: ['agent'] };
  const preview = useMutation({
    mutationFn: () => {
      const a = parseJson<Record<string, unknown>>(sampleArgs);
      if (a.error) throw new Error(t('common.invalidArgs', { error: a.error }));
      return api<PlaygroundResult>('/playground/call', { method: 'POST', body: { tool: tool.name, arguments: a.value, subject, ui: true } }).then((r) => ({ r, args: a.value! }));
    },
  });

  const issues = current.data?.issues ?? [];
  return (
    <div className="stack">
      <p className="hint">{t('views.intro')}</p>
      {current.data === null && !spec && <p className="muted">{t('views.none')}</p>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => suggest.mutate()} disabled={suggest.isPending}>
          {t('views.suggest')}
        </button>
        <label className="row" style={{ gap: 6 }}>
          <span className="label">{t('views.status')}</span>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value as Status)} aria-label={t('views.status')}>
            <option value="active">{t('views.statusActive')}</option>
            <option value="suggested">{t('views.statusSuggested')}</option>
            <option value="disabled">{t('views.statusDisabled')}</option>
          </select>
        </label>
      </div>
      <ErrorBox error={suggest.error} />
      <Field label={t('views.spec')}>
        <Editor value={spec} onChange={setSpec} height="300px" label={t('views.spec')} />
      </Field>
      {issues.length > 0 && (
        <div className="alert warn" role="status">
          {t('views.issues')}{' '}
          <span className="mono">{issues.map((i) => `${i.code} @ ${i.path}`).join(', ')}</span>
        </div>
      )}
      <ErrorBox error={save.error ?? remove.error} />
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" onClick={() => save.mutate()} disabled={!spec || save.isPending}>
          {t('views.save')}
        </button>
        {current.data && (
          <button className="btn danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
            {t('views.remove')}
          </button>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">{t('views.preview')}</span>
          <span className="hint">{t('views.previewHint')}</span>
        </div>
        <div className="panel-body stack">
          <Field label={t('common.arguments')}>
            <Editor value={sampleArgs} onChange={setSampleArgs} height="110px" label={t('common.arguments')} />
          </Field>
          <button className="btn" onClick={() => preview.mutate()} disabled={preview.isPending}>
            {t('views.previewRun')}
          </button>
          <ErrorBox error={preview.error} />
          {preview.data && <ToolUiPreview result={preview.data.r.result} args={preview.data.args} subject={subject} />}
        </div>
      </div>
    </div>
  );
}

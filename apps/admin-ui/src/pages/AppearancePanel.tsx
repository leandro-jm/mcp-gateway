import { ThemeScope, ToolView, type ToolResultLike, type ViewHost } from '@mcp-ui-kit/components';
import '@mcp-ui-kit/components/styles.css';
import { DEFAULT_THEME, META_KEYS, validateTheme, type ThemeTokens, type ToolViews } from '@mcp-ui-kit/view-spec';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { ThemeDto } from '../api/types';
import { useToast } from '../components/toast';
import { ErrorBox, Field } from '../components/ui';
import { getLocale, useT } from '../i18n';
import { useInvalidate, useTenantQuery } from '../lib/hooks';

interface Draft {
  accentLight: string;
  accentDark: string;
  paletteLight: string;
  paletteDark: string;
  radius: string;
  density: 'comfortable' | 'compact';
  tileUrl: string;
  tileAttribution: string;
}

const lines = (s: string) => s.split(/\s+/).map((x) => x.trim()).filter(Boolean);

function fromDto(d: ThemeDto | undefined): Draft {
  const tk = (d?.tokens ?? {}) as ThemeTokens;
  return {
    accentLight: tk.accent?.light ?? DEFAULT_THEME.light.accent,
    accentDark: tk.accent?.dark ?? DEFAULT_THEME.dark.accent,
    paletteLight: (tk.chartPalette?.light ?? []).join('\n'),
    paletteDark: (tk.chartPalette?.dark ?? []).join('\n'),
    radius: tk.radius !== undefined ? String(tk.radius) : '',
    density: tk.density ?? 'comfortable',
    tileUrl: d?.tileUrl ?? '',
    tileAttribution: d?.tileAttribution ?? '',
  };
}

function toTokens(d: Draft): ThemeTokens {
  const light = lines(d.paletteLight);
  const dark = lines(d.paletteDark);
  return {
    accent: { light: d.accentLight, dark: d.accentDark },
    ...(light.length || dark.length ? { chartPalette: { light, dark } } : {}),
    ...(d.radius ? { radius: Number(d.radius) } : {}),
    ...(d.density === 'compact' ? { density: 'compact' as const } : {}),
  };
}

/** Sample views rendered with the draft theme: what the tenant's users will see in their chats. */
function samples(title: string): Array<{ result: ToolResultLike; args?: Record<string, unknown> }> {
  const chart: ToolViews = {
    version: 1,
    result: {
      kind: 'chart',
      title,
      data: 'items',
      mark: 'bar',
      encoding: { x: { field: 'mes', type: 'ordinal' }, y: { field: 'valor', type: 'quantitative', format: 'number' }, color: { field: 'canal', type: 'nominal' } },
    },
  };
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
  const items = months.flatMap((mes, i) => [
    { mes, canal: 'A', valor: 180 + i * 12 },
    { mes, canal: 'B', valor: 120 + ((i * 17) % 40) },
    { mes, canal: 'C', valor: 60 + i * 9 },
  ]);
  const form: ToolViews = {
    version: 1,
    input: {
      kind: 'form',
      tool: 'sample',
      title: 'Form',
      schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', title: 'Name' }, segment: { type: 'string', enum: ['retail', 'wholesale'], title: 'Segment' } } },
      uiSchema: { segment: { 'ui:widget': 'radio' } },
    },
  };
  return [
    { result: { content: [], structuredContent: { items }, _meta: { [META_KEYS.views]: { views: chart, phase: 'result' } } } },
    { result: { content: [], _meta: { [META_KEYS.views]: { views: form, phase: 'input' } } }, args: { name: 'Bela Vista' } },
  ];
}

const inertHost: ViewHost = { callTool: async () => ({ content: [] }), sendMessage: () => undefined };

/** Tenant appearance (ADR-022): accent, chart palette, radius, density and map basemap, with a live preview in both modes. */
export function AppearancePanel() {
  const t = useT();
  const toast = useToast();
  const invalidate = useInvalidate();
  const theme = useTenantQuery<ThemeDto>(['theme'], '/settings/theme');
  const [draft, setDraft] = useState<Draft>(() => fromDto(undefined));
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (theme.data && !loaded) {
      setDraft(fromDto(theme.data));
      setLoaded(true);
    }
  }, [theme.data, loaded]);
  const set = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
  const tokens = useMemo(() => toTokens(draft), [draft]);
  const report = useMemo(() => validateTheme(tokens), [tokens]);
  const previews = useMemo(() => samples(t('views.sampleTitle')), [t]);

  const save = useMutation({
    mutationFn: () =>
      api<ThemeDto>('/settings/theme', {
        method: 'PUT',
        body: { tokens, tileUrl: draft.tileUrl || null, tileAttribution: draft.tileAttribution || null },
      }),
    onSuccess: () => {
      toast('ok', t('views.themeSaved'));
      void invalidate('theme');
    },
  });
  const reset = useMutation({
    mutationFn: () => api('/settings/theme', { method: 'DELETE' }),
    onSuccess: () => {
      setDraft(fromDto(undefined));
      void invalidate('theme');
    },
  });

  return (
    <div className="content stack">
      <p className="hint">{t('views.appearanceIntro')}</p>
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">{t('views.appearance')}</span>
          </div>
          <div className="panel-body">
            <div className="grid-2">
              <Field label={`${t('views.accent')} · ${t('views.light')}`}>
                <input type="color" value={draft.accentLight} onChange={(e) => set({ accentLight: e.target.value })} aria-label={`${t('views.accent')} ${t('views.light')}`} />
              </Field>
              <Field label={`${t('views.accent')} · ${t('views.dark')}`}>
                <input type="color" value={draft.accentDark} onChange={(e) => set({ accentDark: e.target.value })} aria-label={`${t('views.accent')} ${t('views.dark')}`} />
              </Field>
            </div>
            <div className="grid-2">
              <Field label={`${t('views.palette')} · ${t('views.light')}`} hint={t('views.paletteHint')}>
                <textarea className="input mono" rows={8} value={draft.paletteLight} onChange={(e) => set({ paletteLight: e.target.value })} placeholder={DEFAULT_THEME.light.palette.join('\n')} />
              </Field>
              <Field label={`${t('views.palette')} · ${t('views.dark')}`}>
                <textarea className="input mono" rows={8} value={draft.paletteDark} onChange={(e) => set({ paletteDark: e.target.value })} placeholder={DEFAULT_THEME.dark.palette.join('\n')} />
              </Field>
            </div>
            <div className="grid-2">
              <Field label={t('views.radius')}>
                <input className="input" type="number" min={0} max={24} value={draft.radius} placeholder="8" onChange={(e) => set({ radius: e.target.value })} />
              </Field>
              <Field label={t('views.density')}>
                <select className="select" value={draft.density} onChange={(e) => set({ density: e.target.value as Draft['density'] })}>
                  <option value="comfortable">{t('views.densityComfortable')}</option>
                  <option value="compact">{t('views.densityCompact')}</option>
                </select>
              </Field>
            </div>
            <Field label={t('views.tiles')} hint={t('views.tilesHint')}>
              <input className="input mono" value={draft.tileUrl} onChange={(e) => set({ tileUrl: e.target.value })} placeholder="https://tile.example.com/{z}/{x}/{y}.png" />
            </Field>
            <Field label={t('views.attribution')}>
              <input className="input" value={draft.tileAttribution} onChange={(e) => set({ tileAttribution: e.target.value })} />
            </Field>
            {report.errors.length > 0 && (
              <div className="alert error" role="alert">
                <span className="mono">{report.errors.map((i) => `${i.code} @ ${i.path}`).join(', ')}</span>
              </div>
            )}
            {report.warnings.length > 0 && (
              <div className="alert warn" role="status">
                {t('views.warnings')} <span className="mono">{report.warnings.map((i) => i.path).join(', ')}</span>
              </div>
            )}
            <ErrorBox error={save.error ?? reset.error} />
            <div className="row" style={{ gap: 8 }}>
              <button className="btn primary" onClick={() => save.mutate()} disabled={report.errors.length > 0 || save.isPending}>
                {t('views.saveTheme')}
              </button>
              <button className="btn ghost" onClick={() => reset.mutate()} disabled={reset.isPending}>
                {t('views.resetTheme')}
              </button>
            </div>
          </div>
        </div>
        <div className="stack" data-testid="appearance-preview">
          {(['light', 'dark'] as const).map((mode) => (
            <div key={mode} className="panel">
              <div className="panel-head">
                <span className="panel-title">{t(mode === 'light' ? 'views.light' : 'views.dark')}</span>
              </div>
              <ThemeScope mode={mode} tokens={report.errors.length ? undefined : tokens}>
                <div style={{ padding: 12, background: 'var(--color-background-secondary)' }}>
                  {previews.map((p, i) => (
                    <div key={i} style={{ marginBottom: 12 }}>
                      <ToolView result={p.result} args={p.args ?? {}} host={inertHost} locale={getLocale()} />
                    </div>
                  ))}
                </div>
              </ThemeScope>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

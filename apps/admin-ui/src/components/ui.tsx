import { Check, ChevronDown, Copy, Filter as FilterIcon, RefreshCw, Search, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatBytes, formatDateTime, formatNumber } from '@mcp-gateway/i18n';
import { getLocale, useT } from '../i18n';
import { CubeArt } from './CubeArt';

export function PageHeader({ title, subtitle, right }: { title: string; subtitle?: ReactNode; right?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-sub">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

export function LivePill({ value, label }: { value: number | string; label: string }) {
  const t = useT();
  return (
    <div className="live-pill">
      <span className="live-badge">{t('common.live')}</span>
      <span>
        <strong>{value}</strong>
        {label}
      </span>
    </div>
  );
}

export interface TabDef<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: TabDef<T>[]; value: T; onChange(v: T): void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === value} className={`tab ${t.id === value ? 'active' : ''}`} onClick={() => onChange(t.id)}>
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange(v: string): void; placeholder: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(el.tagName) && !el.isContentEditable) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <label className="search">
      <Search size={20} />
      <input ref={ref} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      <kbd>/</kbd>
    </label>
  );
}

export function FiltersButton({ active, onClick }: { active: number; onClick(): void }) {
  const t = useT();
  return (
    <button className="btn" onClick={onClick}>
      <FilterIcon size={18} />
      {t('common.filters')}
      {active ? <span className="badge accent">{active}</span> : null}
    </button>
  );
}

export function RefreshControls({ onRefresh, interval, setInterval: set }: { onRefresh(): void; interval: number; setInterval(v: number): void }) {
  const t = useT();
  return (
    <>
      <button className="icon-btn" title={t('common.refresh')} aria-label={t('common.refresh')} onClick={onRefresh} style={{ border: 'none' }}>
        <RefreshCw size={20} />
      </button>
      <span className="vsep" />
      <label className="refresh-select">
        {t('common.autoRefresh')}
        <select value={interval} onChange={(e) => set(Number(e.target.value))} aria-label={t('common.refreshInterval')}>
          <option value={0}>{t('common.refreshOff')}</option>
          <option value={7000}>7S</option>
          <option value={30000}>30S</option>
          <option value={60000}>60S</option>
        </select>
        <ChevronDown size={16} className="muted" />
      </label>
    </>
  );
}

export function Badge({ kind, children }: { kind?: string; children: ReactNode }) {
  return <span className={`badge ${kind ?? ''}`}>{children}</span>;
}

export function Drawer({ title, subtitle, actions, onClose, children }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; onClose(): void; children: ReactNode }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={typeof title === 'string' ? title : t('common.details')}>
        <div className="drawer-head">
          <div style={{ minWidth: 0 }}>
            <h2 className="drawer-title">{title}</h2>
            {subtitle && <div style={{ marginTop: 8 }}>{subtitle}</div>}
          </div>
          <div className="row">
            {actions}
            <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
              <X size={18} />
            </button>
          </div>
        </div>
        {children}
      </aside>
    </>
  );
}

export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  return [
    copied,
    (text) => {
      void navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    },
  ];
}

/** Code block with the "command" in white and the arguments in orange, as in the reference design. */
export function CodeBlock({ code, highlightFirstWord = false }: { code: string; highlightFirstWord?: boolean }) {
  const t = useT();
  const [copied, copy] = useCopy();
  const [first, ...rest] = code.split(' ');
  return (
    <div className="codeblock">
      {highlightFirstWord ? (
        <>
          {first} <span className="tok">{rest.join(' ')}</span>
        </>
      ) : (
        code
      )}
      <button className="copy" onClick={() => copy(code)} aria-label={t('common.copy')}>
        {copied ? <Check size={18} /> : <Copy size={18} />}
      </button>
    </div>
  );
}

export function JsonView({ value, maxHeight }: { value: unknown; maxHeight?: number }) {
  return (
    <pre className="json" style={maxHeight ? { maxHeight } : undefined}>
      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

export interface EmptyTab {
  id: string;
  label: string;
  content: ReactNode;
}

/** Two-column empty state: illustration + snippet tabs (reference design). */
export function EmptyState({ title, text, tabs, footer }: { title: string; text: string; tabs: EmptyTab[]; footer?: ReactNode }) {
  const [tab, setTab] = useState(tabs[0]?.id ?? '');
  return (
    <div className="empty">
      <div className="empty-left">
        <h2>{title}</h2>
        <p>{text}</p>
        <div className="empty-art">
          <CubeArt />
        </div>
      </div>
      <div className="empty-right">
        <Tabs tabs={tabs.map((t) => ({ id: t.id, label: t.label }))} value={tab} onChange={setTab} />
        <div className="body">
          {tabs.find((t) => t.id === tab)?.content}
          {footer && <div className="empty-foot">{footer}</div>}
        </div>
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as { message?: string; payload?: { details?: unknown } };
  return (
    <div className="alert error">
      {e.message ?? String(error)}
      {e.payload?.details ? <pre style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>{JSON.stringify(e.payload.details, null, 2)}</pre> : null}
    </div>
  );
}

/** Date and time in the active locale. */
export const fmtDate = (iso: string | null | undefined) => (iso ? formatDateTime(getLocale(), iso) : '—');

/** Bytes in the active locale (decimal separator per language). */
export const fmtBytes = (n: number | null | undefined) => (n === null || n === undefined ? '—' : formatBytes(getLocale(), n));

/** Plain number in the active locale. */
export const fmtNumber = (n: number) => formatNumber(getLocale(), n);

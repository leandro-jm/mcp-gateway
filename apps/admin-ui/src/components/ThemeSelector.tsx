import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useT, type UiMessageKey } from '../i18n';
import { useTheme, type ThemePref } from '../theme/theme';

const OPTIONS: Array<{ id: ThemePref; label: UiMessageKey; icon: typeof Sun }> = [
  { id: 'system', label: 'shell.themeSystem', icon: Monitor },
  { id: 'light', label: 'shell.themeLight', icon: Sun },
  { id: 'dark', label: 'shell.themeDark', icon: Moon },
];

/** Theme picker (System / Light / Dark) in the topbar. */
export function ThemeSelector() {
  const t = useT();
  const { pref, resolved, setPref } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const Icon = pref === 'system' ? Monitor : resolved === 'light' ? Sun : Moon;
  return (
    <div className="menu-anchor" ref={ref}>
      <button
        className="icon-btn"
        aria-label={t('shell.theme')}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('shell.themeCurrent', { theme: t(OPTIONS.find((o) => o.id === pref)!.label) })}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon size={20} />
      </button>
      {open && (
        <div className="menu" role="menu" aria-label={t('shell.theme')}>
          <div className="menu-label">{t('shell.theme')}</div>
          {OPTIONS.map((o) => (
            <button
              key={o.id}
              role="menuitemradio"
              aria-checked={pref === o.id}
              className={`menu-item ${pref === o.id ? 'active' : ''}`}
              onClick={() => {
                setPref(o.id);
                setOpen(false);
              }}
            >
              <o.icon size={16} />
              <span>{t(o.label)}</span>
              {pref === o.id && <Check size={16} className="menu-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

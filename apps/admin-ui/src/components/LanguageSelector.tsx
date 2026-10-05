import { LOCALE_NAMES, LOCALES, type Locale } from '@mcp-gateway/i18n';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Languages } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { Me } from '../api/types';
import { useI18n } from '../i18n';
import { useToast } from './toast';

/** Language picker in the topbar. The choice is saved in the user's profile (`PATCH /me`, ADR-012). */
export function LanguageSelector() {
  const { locale, setLocale, t } = useI18n();
  const queryClient = useQueryClient();
  const toast = useToast();
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

  const choose = async (next: Locale) => {
    setOpen(false);
    if (next === locale) return;
    const previous = locale;
    setLocale(next);
    try {
      const me = await api<Me>('/me', { method: 'PATCH', body: { locale: next }, tenant: null });
      queryClient.setQueryData(['me'], me);
      // server-rendered texts (errors, policy explanations) change language too
      await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    } catch (err) {
      setLocale(previous);
      toast('error', t('shell.languageSaveFailed', { error: (err as Error).message }));
    }
  };

  return (
    <div className="menu-anchor" ref={ref}>
      <button
        className="icon-btn"
        aria-label={t('shell.language')}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('shell.languageCurrent', { language: LOCALE_NAMES[locale] })}
        onClick={() => setOpen((o) => !o)}
      >
        <Languages size={20} />
      </button>
      {open && (
        <div className="menu" role="menu" aria-label={t('shell.language')}>
          <div className="menu-label">{t('shell.language')}</div>
          {LOCALES.map((l) => (
            <button
              key={l}
              role="menuitemradio"
              aria-checked={locale === l}
              lang={l}
              className={`menu-item ${locale === l ? 'active' : ''}`}
              onClick={() => void choose(l)}
            >
              <span>{LOCALE_NAMES[l]}</span>
              {locale === l && <Check size={16} className="menu-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

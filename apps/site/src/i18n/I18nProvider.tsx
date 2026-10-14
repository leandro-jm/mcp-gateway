import type { Locale, Params } from '@mcp-gateway/i18n';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { translateSite, type SiteMessageKey } from './catalog';
import { initialLocale, persistLocale } from './locale';

export type T = (key: SiteMessageKey, params?: Params) => string;

interface I18nState {
  locale: Locale;
  setLocale(locale: Locale): void;
  t: T;
}

const I18nContext = createContext<I18nState | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const t = useCallback<T>((key, params) => translateSite(locale, params ? { key, params } : { key }), [locale]);

  useEffect(() => {
    persistLocale(locale);
    document.title = t('nav.docTitle');
  }, [locale, t]);

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nState {
  const s = useContext(I18nContext);
  if (!s) throw new Error('useI18n outside of I18nProvider');
  return s;
}

/** Translation function for the active locale. */
export const useT = (): T => useI18n().t;

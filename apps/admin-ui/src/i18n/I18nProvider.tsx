import type { Locale, Params } from '@mcp-gateway/i18n';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { translateUi, type UiMessageKey } from './catalog';
import { getLocale, setCurrentLocale } from './locale';

export type T = (key: UiMessageKey, params?: Params) => string;

interface I18nState {
  locale: Locale;
  /** Switches the UI language locally. Persisting it in the profile is up to the caller (`PATCH /me`). */
  setLocale(locale: Locale): void;
  t: T;
}

const I18nContext = createContext<I18nState | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const l = getLocale();
    setCurrentLocale(l);
    return l;
  });
  const setLocale = useCallback((l: Locale) => {
    setCurrentLocale(l);
    setLocaleState(l);
  }, []);
  const t = useCallback<T>((key, params) => translateUi(locale, params ? { key, params } : { key }), [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nState {
  const s = useContext(I18nContext);
  if (!s) throw new Error('useI18n outside of I18nProvider');
  return s;
}

/** Translation function for the active locale. */
export const useT = (): T => useI18n().t;

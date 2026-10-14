import { DEFAULT_LOCALE, isLocale, toLocale, type Locale } from '@mcp-gateway/i18n';

export const LOCALE_STORAGE_KEY = 'mcp-gw-site:locale';

/** `?lang=` wins (shareable links), then the last choice, then the browser languages (ADR-020). */
export function initialLocale(): Locale {
  const fromQuery = new URLSearchParams(location.search).get('lang');
  if (isLocale(fromQuery)) return fromQuery;
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    /* storage unavailable */
  }
  for (const tag of navigator.languages ?? [navigator.language]) {
    const l = toLocale(tag);
    if (l) return l;
  }
  return DEFAULT_LOCALE;
}

export function persistLocale(locale: Locale): void {
  document.documentElement.lang = locale;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* storage unavailable */
  }
  // Keep a shared link in sync with what the visitor is reading.
  const url = new URL(location.href);
  if (url.searchParams.has('lang')) {
    url.searchParams.set('lang', locale);
    history.replaceState(null, '', url);
  }
}

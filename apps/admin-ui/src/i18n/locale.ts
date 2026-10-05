import { DEFAULT_LOCALE, isLocale, toLocale, type Locale } from '@mcp-gateway/i18n';

/**
 * Active locale outside React (API client `Accept-Language`, date/number formatters).
 * The source of truth is the user's profile (`me.locale`, ADR-012); localStorage is only a
 * cache so the login screen and first paint use the last known language.
 */
export const LOCALE_STORAGE_KEY = 'mcp-gw:locale';

function initialLocale(): Locale {
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

let current: Locale = initialLocale();

export const getLocale = (): Locale => current;

export function setCurrentLocale(locale: Locale): void {
  current = locale;
  document.documentElement.lang = locale;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* storage unavailable */
  }
}

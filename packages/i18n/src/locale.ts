/** Supported locales (ADR-012). `en` is the default and the fallback for missing keys. */
export const LOCALES = ['en', 'pt-BR', 'es'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

/** Native names, shown in language pickers regardless of the active locale. */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', 'pt-BR': 'Português', es: 'Español' };

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Maps a BCP 47 tag to a supported locale (`pt`, `pt-PT` → `pt-BR`; `es-MX` → `es`; `en-US` → `en`). */
export function toLocale(tag: string | null | undefined): Locale | undefined {
  if (!tag) return undefined;
  const lang = tag.trim().toLowerCase().split(/[-_]/)[0];
  if (lang === 'pt') return 'pt-BR';
  if (lang === 'es') return 'es';
  if (lang === 'en') return 'en';
  return undefined;
}

/** Picks the best supported locale from an `Accept-Language` header, honoring q-values. */
export function negotiate(acceptLanguage: string | null | undefined, fallback: Locale = DEFAULT_LOCALE): Locale {
  if (!acceptLanguage) return fallback;
  const ranked = acceptLanguage
    .split(',')
    .map((part, index) => {
      const [tag = '', ...attrs] = part.trim().split(';');
      const q = attrs.map((a) => a.trim()).find((a) => a.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag, weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((r) => r.tag && r.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const r of ranked) {
    const locale = toLocale(r.tag);
    if (locale) return locale;
  }
  return fallback;
}

import { DEFAULT_LOCALE, LOCALES, type Locale } from './locale';

/** A translatable message: catalog key plus parameters. Params may be nested messages. */
export interface Message<K extends string = string> {
  key: K;
  params?: Params;
}
export type ParamValue = string | number | boolean | null | undefined | Message;
export type Params = Readonly<Record<string, ParamValue>>;

/**
 * Messages of one area in every locale. `en` is the source of truth; the other locales must
 * have exactly the same keys (missing or extra keys fail the typecheck).
 */
export type AreaMessages<E extends Record<string, string>> = { readonly en: E } & {
  readonly [L in Exclude<Locale, 'en'>]: { readonly [K in keyof E]: string };
};

/** Declares the messages of an area. Every key must start with `<prefix>.`, which keeps areas collision-free. */
export function defineMessages<P extends string, const E extends Record<string, string>>(
  _prefix: P,
  messages: AreaMessages<E> & { readonly en: { readonly [K in keyof E]: K extends `${P}.${string}` ? string : `key must start with "${P}."` } },
): AreaMessages<E> {
  return messages;
}

export type KeysOf<A> = A extends { readonly en: infer E } ? keyof E & string : never;

export type Catalog = Readonly<Record<Locale, Readonly<Record<string, string>>>>;

/** Merges area messages into one catalog. Throws on duplicate keys. */
export function mergeCatalogs(areas: ReadonlyArray<AreaMessages<Record<string, string>>>): Catalog {
  const out = Object.fromEntries(LOCALES.map((l) => [l, {} as Record<string, string>])) as Record<Locale, Record<string, string>>;
  for (const area of areas) {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(area[locale])) {
        if (key in out[locale]) throw new Error(`duplicate i18n key: ${key}`);
        out[locale][key] = value;
      }
    }
  }
  return out;
}

export function isMessage(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && typeof (value as { key?: unknown }).key === 'string';
}

const pluralRules = new Map<string, Intl.PluralRules>();
function pluralCategory(locale: Locale, n: number): string {
  let rules = pluralRules.get(locale);
  if (!rules) pluralRules.set(locale, (rules = new Intl.PluralRules(locale)));
  return rules.select(n);
}

/** Index of the `}` matching the `{` at `open`, or -1. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Parses `sel {body} sel {body} ...` into a map. */
function parseOptions(text: string): Map<string, string> {
  const options = new Map<string, string>();
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const close = matchBrace(text, open);
    if (close < 0) break;
    const selector = text.slice(i, open).trim();
    if (selector) options.set(selector, text.slice(open + 1, close));
    i = close + 1;
  }
  return options;
}

type ParamRenderer = (value: ParamValue) => string;

/**
 * Renders a simplified ICU template: `{name}`, `{n, plural, =0 {...} one {...} other {...}}`
 * (`#` is the formatted number) and `{x, select, a {...} other {...}}`.
 * Unknown params are left as-is so mistakes are visible instead of silently dropped.
 */
export function formatTemplate(template: string, params: Params | undefined, locale: Locale, renderParam: ParamRenderer, hash?: string): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const ch = template[i]!;
    if (ch === '#' && hash !== undefined) {
      out += hash;
      i++;
      continue;
    }
    if (ch !== '{') {
      out += ch;
      i++;
      continue;
    }
    const close = matchBrace(template, i);
    if (close < 0) {
      out += template.slice(i);
      break;
    }
    const inner = template.slice(i + 1, close);
    i = close + 1;
    const firstComma = inner.indexOf(',');
    const name = (firstComma < 0 ? inner : inner.slice(0, firstComma)).trim();
    const value = params?.[name];
    if (firstComma < 0) {
      out += value === undefined ? `{${inner}}` : renderParam(value);
      continue;
    }
    const rest = inner.slice(firstComma + 1);
    const secondComma = rest.indexOf(',');
    const kind = rest.slice(0, secondComma).trim();
    const options = parseOptions(rest.slice(secondComma + 1));
    if (kind === 'plural') {
      const n = Number(value);
      const body = options.get(`=${n}`) ?? options.get(pluralCategory(locale, n)) ?? options.get('other') ?? '';
      out += formatTemplate(body, params, locale, renderParam, new Intl.NumberFormat(locale).format(n));
    } else if (kind === 'select') {
      const body = options.get(String(value)) ?? options.get('other') ?? '';
      out += formatTemplate(body, params, locale, renderParam, hash);
    } else {
      out += `{${inner}}`;
    }
  }
  return out;
}

export type Translate<K extends string> = (locale: Locale, message: Message<K>) => string;

/** Builds a translator over a catalog. Missing keys fall back to `en`, then to the key itself. */
export function createTranslator<K extends string>(catalog: Catalog): Translate<K> {
  const translate = (locale: Locale, message: Message): string => {
    const template = catalog[locale][message.key] ?? catalog[DEFAULT_LOCALE][message.key] ?? message.key;
    const renderParam: ParamRenderer = (v) => (isMessage(v) ? translate(locale, v) : v === null ? '' : String(v));
    return formatTemplate(template, message.params, locale, renderParam);
  };
  return translate;
}

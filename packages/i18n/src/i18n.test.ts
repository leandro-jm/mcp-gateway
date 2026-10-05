import { describe, expect, it } from 'vitest';
import { formatBytes, formatDateTime, formatPercent } from './intl';
import { isLocale, LOCALES, negotiate, toLocale } from './locale';
import { createTranslator, defineMessages, mergeCatalogs } from './messages';
import { msg, raw, serverCatalog, translate } from './server';

const area = defineMessages('t', {
  en: {
    't.hello': 'Hello, {name}!',
    't.tools': '{count, plural, =0 {no tools} one {# tool} other {# tools}}',
    't.state': '{state, select, enabled {on} other {off}}',
    't.nested': 'Error: {inner}',
    't.onlyEn': 'only english',
  },
  'pt-BR': {
    't.hello': 'Olá, {name}!',
    't.tools': '{count, plural, =0 {nenhuma tool} one {# tool} other {# tools}}',
    't.state': '{state, select, enabled {ligada} other {desligada}}',
    't.nested': 'Erro: {inner}',
    't.onlyEn': '',
  },
  es: {
    't.hello': '¡Hola, {name}!',
    't.tools': '{count, plural, =0 {ninguna tool} one {# tool} other {# tools}}',
    't.state': '{state, select, enabled {activa} other {inactiva}}',
    't.nested': 'Error: {inner}',
    't.onlyEn': '',
  },
});
const t = createTranslator(mergeCatalogs([area]));

describe('translator', () => {
  it('interpolates params', () => {
    expect(t('en', { key: 't.hello', params: { name: 'Ana' } })).toBe('Hello, Ana!');
    expect(t('pt-BR', { key: 't.hello', params: { name: 'Ana' } })).toBe('Olá, Ana!');
    expect(t('es', { key: 't.hello', params: { name: 'Ana' } })).toBe('¡Hola, Ana!');
  });

  it('pluralizes with exact matches and locale rules', () => {
    expect(t('en', { key: 't.tools', params: { count: 0 } })).toBe('no tools');
    expect(t('en', { key: 't.tools', params: { count: 1 } })).toBe('1 tool');
    expect(t('en', { key: 't.tools', params: { count: 1200 } })).toBe('1,200 tools');
    expect(t('pt-BR', { key: 't.tools', params: { count: 1200 } })).toBe('1.200 tools');
    expect(t('es', { key: 't.tools', params: { count: 0 } })).toBe('ninguna tool');
  });

  it('selects by value', () => {
    expect(t('pt-BR', { key: 't.state', params: { state: 'enabled' } })).toBe('ligada');
    expect(t('es', { key: 't.state', params: { state: 'disabled' } })).toBe('inactiva');
  });

  it('translates nested messages in the same locale', () => {
    expect(t('pt-BR', { key: 't.nested', params: { inner: { key: 't.hello', params: { name: 'Bia' } } } })).toBe('Erro: Olá, Bia!');
  });

  it('keeps unknown params visible and falls back to the key', () => {
    expect(t('en', { key: 't.hello' })).toBe('Hello, {name}!');
    expect(t('es', { key: 'missing.key' })).toBe('missing.key');
  });

  it('rejects duplicate keys across areas', () => {
    expect(() => mergeCatalogs([area, area])).toThrow(/duplicate/);
  });
});

describe('locale', () => {
  it('maps tags to supported locales', () => {
    expect(toLocale('pt')).toBe('pt-BR');
    expect(toLocale('pt-PT')).toBe('pt-BR');
    expect(toLocale('es-MX')).toBe('es');
    expect(toLocale('en_US')).toBe('en');
    expect(toLocale('fr')).toBeUndefined();
    expect(isLocale('pt-BR')).toBe(true);
    expect(isLocale('pt')).toBe(false);
  });

  it('negotiates Accept-Language honoring q-values', () => {
    expect(negotiate('fr-FR,fr;q=0.9,es;q=0.8,en;q=0.7')).toBe('es');
    expect(negotiate('en;q=0.5, pt-BR')).toBe('pt-BR');
    expect(negotiate('de, *;q=0.1')).toBe('en');
    expect(negotiate(undefined, 'es')).toBe('es');
  });
});

describe('intl', () => {
  it('formats bytes, percents and dates per locale', () => {
    expect(formatBytes('en', 512)).toBe('512 B');
    expect(formatBytes('en', 1536)).toBe('1.5 KB');
    expect(formatBytes('pt-BR', 1536)).toBe('1,5 KB');
    expect(formatBytes('es', 5 * 1024 * 1024)).toBe('5,0 MB');
    expect(formatPercent('en', 0.42)).toBe('42%');
    const iso = '2026-10-03T14:05:09';
    expect(formatDateTime('en', iso)).toMatch(/^10\/03\/26/);
    expect(formatDateTime('pt-BR', iso)).toMatch(/^03\/10\/26/);
  });
});

describe('server catalog', () => {
  it('has every key in every locale', () => {
    const keys = Object.keys(serverCatalog.en).sort();
    for (const locale of LOCALES) expect(Object.keys(serverCatalog[locale]).sort()).toEqual(keys);
  });

  it('has no empty translations', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(serverCatalog[locale])) expect(value, `${locale} ${key}`).not.toBe('');
    }
  });

  it('renders typed messages and raw text', () => {
    expect(translate(msg('common.toolNotFound', { tool: 'x' }), 'pt-BR')).toBe('Tool desconhecida: x');
    expect(translate(msg('common.notFound', { resource: msg('resource.user'), id: '42' }), 'es')).toBe('No encontrado: usuario 42');
    expect(translate(raw('upstream said {x}'), 'es')).toBe('upstream said {x}');
  });
});

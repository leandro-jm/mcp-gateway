import { META_KEYS, type ToolViews } from '@mcp-ui-kit/view-spec';
import { describe, expect, it } from 'vitest';
import type { CallContext } from '../src/proxy/executor';
import { clientHasUi, ConfirmTokens, descriptorUiMeta, fieldErrors, resultUiMeta, tileHost, uiRequestOf } from '../src/proxy/ui';
import type { RegistrySnapshot } from '../src/registry/snapshot';

const table: ToolViews = { version: 1, result: { kind: 'table', data: 'items', columns: [{ field: 'nome' }] } };
const map: ToolViews = { version: 1, result: { kind: 'map', data: '', lat: 'lat', lng: 'lng' } };

const ctx = (sub = 'user-1', tenantId = 't1') => ({ tenantId, principal: { sub } }) as unknown as CallContext;
const snapshot = (theme?: RegistrySnapshot['theme']) => ({ theme }) as unknown as RegistrySnapshot;

describe('generative UI helpers (ADR-022)', () => {
  it('decides who gets UI: 2025 clients and 2026 clients that declared MCP Apps', () => {
    expect(clientHasUi(undefined)).toBe(false);
    expect(clientHasUi({ era: 'legacy', extensions: [] })).toBe(true);
    expect(clientHasUi({ era: 'modern', extensions: [] })).toBe(false);
    expect(clientHasUi({ era: 'modern', extensions: ['io.modelcontextprotocol/ui'] })).toBe(true);
  });

  it('points tools to the right generic MCP App', () => {
    expect(descriptorUiMeta(table)).toEqual({ ui: { resourceUri: 'ui://mcp-gateway/view' }, 'openai/outputTemplate': 'ui://mcp-gateway/view' });
    expect(descriptorUiMeta(map)).toMatchObject({ ui: { resourceUri: 'ui://mcp-gateway/map' } });
  });

  it('adds the basemap only to map views and the theme only when set', () => {
    const s = snapshot({ tokens: { radius: 4 }, tileUrl: 'https://tiles.example.com/{z}/{x}/{y}.png', tileAttribution: '© OSM' });
    expect(resultUiMeta(s, { views: map, phase: 'result' })[META_KEYS.views]).toMatchObject({ mapTiles: { url: 'https://tiles.example.com/{z}/{x}/{y}.png', attribution: '© OSM' } });
    expect(resultUiMeta(s, { views: table, phase: 'result' })[META_KEYS.views]).not.toHaveProperty('mapTiles');
    expect(resultUiMeta(snapshot(null), { views: table, phase: 'result' })).not.toHaveProperty(META_KEYS.theme);
    expect(tileHost(s)).toBe('https://tiles.example.com');
    expect(tileHost(snapshot({ tokens: {}, tileUrl: 'http://insecure.example/{z}/{x}/{y}', tileAttribution: null }))).toBeUndefined();
  });

  it('reads UI hints from request _meta, ignoring anything else', () => {
    expect(uiRequestOf({ [META_KEYS.confirm]: 'tok', [META_KEYS.origin]: 'app' })).toEqual({ confirmToken: 'tok', origin: 'app' });
    expect(uiRequestOf({ [META_KEYS.origin]: 'model' })).toBeUndefined();
    expect(uiRequestOf({ traceparent: 'x' })).toBeUndefined();
    expect(uiRequestOf({ [META_KEYS.confirm]: 'x'.repeat(600) })).toEqual({});
  });

  it('maps validator details to localized field errors', () => {
    const details = [
      { path: '/', message: "must have required property 'data_hora'" },
      { path: '/tipo', message: 'must be equal to one of the allowed values' },
      { path: '/', message: 'must NOT have additional properties', field: 'extra' },
    ];
    expect(fieldErrors(details, 'pt-BR')).toEqual({ data_hora: 'Campo obrigatório.', tipo: 'Valor inválido.', extra: 'Valor inválido.' });
    expect(fieldErrors(undefined, 'en')).toEqual({});
  });

  it('confirmation tokens: bound to tenant, subject and tool, single use', async () => {
    const tokens = new ConfirmTokens(async (t) => Buffer.from(`key-${t}`));
    const tok = await tokens.issue(ctx(), 'rh_delete');
    expect(await tokens.consume(ctx('user-2'), 'rh_delete', tok)).toBe(false);
    expect(await tokens.consume(ctx('user-1', 't2'), 'rh_delete', tok)).toBe(false);
    expect(await tokens.consume(ctx(), 'rh_other', tok)).toBe(false);
    expect(await tokens.consume(ctx(), 'rh_delete', `${tok}x`)).toBe(false);
    expect(await tokens.consume(ctx(), 'rh_delete', 'garbage')).toBe(false);
    expect(await tokens.consume(ctx(), 'rh_delete', tok)).toBe(true);
    expect(await tokens.consume(ctx(), 'rh_delete', tok)).toBe(false);
  });
});

import type { JsonObject } from '@mcp-gateway/db';
import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { infer, META_KEYS, type ToolLike } from '@mcp-ui-kit/view-spec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness';
import { mcpClient, modernMcpClient, seedRhTenant, type SeededTenant } from './seed';

const UI = { capabilities: { extensions: { 'io.modelcontextprotocol/ui': {} } } };

describe('generative UI on tool results (F18, ADR-022)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let base: string;
  let token: string;

  async function activate(names: string[]) {
    for (const name of names) {
      const t = await h.services.repos.tools.get(seeded.tenantId, seeded.tools[name]!);
      const tool: ToolLike = { name: t.name, inputSchema: t.inputSchema, ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}), annotations: t.annotations };
      const views = infer(tool)!;
      await h.services.repos.toolViews.upsert(seeded.tenantId, t.id, views as unknown as JsonObject, 'active');
    }
    await h.services.registry.invalidate(seeded.tenantId);
  }

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    seeded = await seedRhTenant(h, up);
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    token = await h.token({ tenant: 'acme' });
    await h.services.repos.tenantThemes.upsert(seeded.tenantId, {
      tokens: { accent: { light: '#0b5cad', dark: '#5aa2f0' } },
      tileUrl: 'https://tiles.example.com/{z}/{x}/{y}.png',
    });
    await activate(['rh_colaboradores_list', 'rh_marcacao_create', 'rh_marcacao_delete']);
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
  });

  it('advertises the MCP App only to clients with UI', async () => {
    const ui = await modernMcpClient(base, token, '/mcp', UI);
    const plain = await modernMcpClient(base, token);
    try {
      const withUi = (await ui.listTools()).tools.find((t) => t.name === 'rh_colaboradores_list')!;
      expect(withUi._meta).toEqual({ ui: { resourceUri: 'ui://mcp-gateway/view' }, 'openai/outputTemplate': 'ui://mcp-gateway/view' });
      expect((await ui.listTools()).tools.find((t) => t.name === 'rh_escalas_list')!._meta).toBeUndefined();
      const without = (await plain.listTools()).tools.find((t) => t.name === 'rh_colaboradores_list')!;
      expect(without._meta).toBeUndefined();
    } finally {
      await ui.close();
      await plain.close();
    }
  });

  it('results carry the view and the tenant theme in _meta; content is unchanged', async () => {
    const ui = await modernMcpClient(base, token, '/mcp', UI);
    const plain = await modernMcpClient(base, token);
    try {
      const args = { name: 'rh_colaboradores_list', arguments: { size: 2 } };
      const r = await ui.callTool(args);
      const p = await plain.callTool(args);
      expect(r.content).toEqual(p.content);
      expect(r.structuredContent).toEqual(p.structuredContent);
      expect(r._meta?.[META_KEYS.views]).toMatchObject({ phase: 'result', views: { version: 1, result: { kind: 'table', data: 'items' } } });
      expect(r._meta?.[META_KEYS.theme]).toEqual({ accent: { light: '#0b5cad', dark: '#5aa2f0' } });
      expect(p._meta?.[META_KEYS.views]).toBeUndefined();
    } finally {
      await ui.close();
      await plain.close();
    }
  });

  it('a 2025 client also gets the view (its capabilities are not visible to a stateless request)', async () => {
    const legacy = await mcpClient(base, token);
    try {
      const tool = (await legacy.listTools()).tools.find((t) => t.name === 'rh_colaboradores_list')!;
      expect((tool._meta as { ui?: unknown } | undefined)?.ui).toEqual({ resourceUri: 'ui://mcp-gateway/view' });
      const r = await legacy.callTool({ name: 'rh_colaboradores_list', arguments: { size: 1 } });
      expect((r._meta as Record<string, unknown>)[META_KEYS.views]).toMatchObject({ phase: 'result' });
    } finally {
      await legacy.close();
    }
  });

  it('serves the generic MCP Apps as ui:// resources with their CSP', async () => {
    const ui = await modernMcpClient(base, token, '/mcp', UI);
    try {
      const listed = (await ui.listResources()).resources.map((r) => r.uri);
      expect(listed).toEqual(expect.arrayContaining(['ui://mcp-gateway/view', 'ui://mcp-gateway/map', 'ui://mcp-gateway/diagram']));
      const view = (await ui.readResource({ uri: 'ui://mcp-gateway/view' })).contents[0]!;
      expect(view.mimeType).toBe('text/html;profile=mcp-app');
      expect((view as { text: string }).text).toContain('<div id="root">');
      const map = (await ui.readResource({ uri: 'ui://mcp-gateway/map' })).contents[0]!;
      expect(map._meta).toMatchObject({ ui: { csp: { resourceDomains: ['https://tiles.example.com'], connectDomains: [] } } });
      await expect(ui.readResource({ uri: 'ui://mcp-gateway/nope' })).rejects.toMatchObject({ code: -32602 });
    } finally {
      await ui.close();
    }
  });

  it('invalid arguments come back as a prefilled form with field errors', async () => {
    const ui = await modernMcpClient(base, token, '/mcp', UI);
    try {
      const r = await ui.callTool({ name: 'rh_marcacao_create', arguments: { tipo: 'entrada' } });
      expect(r.isError).toBe(true);
      const payload = r._meta?.[META_KEYS.views] as { phase: string; errors: Record<string, string>; views: { input: { kind: string } } };
      expect(payload.phase).toBe('input');
      expect(payload.views.input.kind).toBe('form');
      expect(payload.errors).toMatchObject({ colaborador_id: 'Required field.', data_hora: 'Required field.' });
    } finally {
      await ui.close();
    }
  });

  it('a destructive call waits for a human confirmation; the token works once', async () => {
    const ui = await modernMcpClient(base, token, '/mcp', UI);
    const target = up.data.marcacoes[0]!.id;
    const deletes = () => up.requests.filter((r) => r.method === 'DELETE').length;
    try {
      const before = deletes();
      const first = await ui.callTool({ name: 'rh_marcacao_delete', arguments: { id: target } });
      expect(first.isError).toBeFalsy();
      expect(first.structuredContent).toBeUndefined();
      expect((first.content as Array<{ text: string }>)[0]!.text).toMatch(/was not executed/);
      expect(deletes()).toBe(before);
      const payload = first._meta?.[META_KEYS.views] as { phase: string; confirmToken: string };
      expect(payload.phase).toBe('input');
      expect(payload.confirmToken).toMatch(/\./);

      // a forged token is not a confirmation
      const forged = await ui.callTool({ name: 'rh_marcacao_delete', arguments: { id: target }, _meta: { [META_KEYS.confirm]: `${payload.confirmToken}x` } });
      expect((forged._meta?.[META_KEYS.views] as { phase: string }).phase).toBe('input');
      expect(deletes()).toBe(before);

      const confirmed = await ui.callTool({ name: 'rh_marcacao_delete', arguments: { id: target }, _meta: { [META_KEYS.confirm]: payload.confirmToken, [META_KEYS.origin]: 'app' } });
      expect(confirmed.isError).toBeFalsy();
      expect(deletes()).toBe(before + 1);

      const replay = await ui.callTool({ name: 'rh_marcacao_delete', arguments: { id: target }, _meta: { [META_KEYS.confirm]: payload.confirmToken } });
      expect((replay._meta?.[META_KEYS.views] as { phase: string }).phase).toBe('input');
      expect(deletes()).toBe(before + 1);
    } finally {
      await ui.close();
    }
  });

  it('a token issued to one subject does not confirm for another', async () => {
    const ui = await modernMcpClient(base, token, '/mcp', UI);
    const other = await modernMcpClient(base, await h.token({ sub: 'user-2', tenant: 'acme' }), '/mcp', UI);
    const target = up.data.marcacoes[0]!.id;
    try {
      const first = await ui.callTool({ name: 'rh_marcacao_delete', arguments: { id: target } });
      const tok = (first._meta?.[META_KEYS.views] as { confirmToken: string }).confirmToken;
      const stolen = await other.callTool({ name: 'rh_marcacao_delete', arguments: { id: target }, _meta: { [META_KEYS.confirm]: tok } });
      expect((stolen._meta?.[META_KEYS.views] as { phase: string }).phase).toBe('input');
    } finally {
      await ui.close();
      await other.close();
    }
  });

  it('clients without UI keep today\'s behavior: the destructive call runs under the usual policy', async () => {
    const plain = await modernMcpClient(base, token);
    const target = up.data.marcacoes[1]!.id;
    const deletes = () => up.requests.filter((r) => r.method === 'DELETE').length;
    try {
      const before = deletes();
      const r = await plain.callTool({ name: 'rh_marcacao_delete', arguments: { id: target } });
      expect(r.isError).toBeFalsy();
      expect(deletes()).toBe(before + 1);
    } finally {
      await plain.close();
    }
  });

  it('admin API: validates specs and themes, suggests views, and the change reaches the data plane', async () => {
    const admin = await h.adminToken('acme');
    const auth = { authorization: `Bearer ${admin}` };
    const toolId = seeded.tools.rh_escalas_list!;

    const bad = await h.app.inject({ method: 'PUT', url: `/admin/v1/tools/${toolId}/view`, headers: auth, payload: { views: { version: 1, result: { kind: 'table', data: 'items', columns: [{ field: 'nope' }] } } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details.issues).toEqual([{ code: 'unknown_field', path: '$.result.columns[0].field' }]);

    const suggested = await h.app.inject({ method: 'POST', url: `/admin/v1/tools/${toolId}/view/suggest`, headers: auth });
    expect(suggested.statusCode).toBe(200);
    const put = await h.app.inject({ method: 'PUT', url: `/admin/v1/tools/${toolId}/view`, headers: auth, payload: { views: suggested.json().views, status: 'active' } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ status: 'active', issues: [] });

    const ui = await modernMcpClient(base, token, '/mcp', UI);
    try {
      const tool = (await ui.listTools()).tools.find((t) => t.name === 'rh_escalas_list')!;
      expect(tool._meta).toMatchObject({ ui: { resourceUri: 'ui://mcp-gateway/view' } });
    } finally {
      await ui.close();
    }

    const theme = await h.app.inject({ method: 'PUT', url: '/admin/v1/settings/theme', headers: auth, payload: { tokens: { accent: { light: '#f5f5f5', dark: '#3bc09f' } } } });
    expect(theme.statusCode).toBe(400);
    expect(theme.json().details.issues).toEqual([{ code: 'low_contrast', path: '$.accent.light' }]);
    const tiles = await h.app.inject({ method: 'PUT', url: '/admin/v1/settings/theme', headers: auth, payload: { tokens: {}, tileUrl: 'javascript:alert(1)//{z}{x}{y}' } });
    expect(tiles.statusCode).toBe(400);
  });

  it('views are tenant-scoped', async () => {
    const other = await modernMcpClient(base, await h.token({ sub: 'u-globex', tenant: 'globex' }), '/mcp', UI);
    try {
      expect((await other.listTools()).tools.some((t) => t._meta)).toBe(false);
    } finally {
      await other.close();
    }
  });
});

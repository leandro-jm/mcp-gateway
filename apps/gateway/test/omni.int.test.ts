import { startFakeUpstream, syntheticTools, type FakeUpstream } from '@mcp-gateway/testkit';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorPayload } from '../src/proxy/result';
import { startHarness, type Harness } from './harness';
import { mcpClient, seedRhTenant, type SeededTenant } from './seed';

const chars = (v: unknown) => JSON.stringify(v).length;
const tokens = (v: unknown) => Math.ceil(chars(v) / 4);

describe('Omni MCP (F7.2)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let base: string;
  let seeded: SeededTenant;
  let token: string;
  const clients: Client[] = [];

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    seeded = await seedRhTenant(h, up);
    const existing = new Set(Object.keys(seeded.tools));
    for (const t of syntheticTools().filter((t) => !existing.has(t.name))) {
      await h.services.repos.tools.create(seeded.tenantId, { kind: 'manual', ...t, state: 'enabled' });
    }
    // an explicit allow by pattern unlocks the destructive ones (allow `*` does not cover them)
    await h.services.repos.policies.create(seeded.tenantId, { subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: '*_delete' });
    await h.services.registry.invalidate(seeded.tenantId);
    token = await h.token({ tenant: 'acme', sub: 'agente-omni' });
  });
  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => undefined);
    await h?.teardown();
    await up?.close();
  });

  const connect = async (path: string, headers: Record<string, string> = {}, tk = token) => {
    const c = new Client({ name: 'agente-teste', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}${path}`), { requestInit: { headers: { authorization: `Bearer ${tk}`, ...headers } } }));
    clients.push(c);
    return c;
  };

  it('exposes only 3 meta-tools and solves a task with < 15% of the definition tokens of the full /mcp', async () => {
    const full = await mcpClient(base, token);
    clients.push(full);
    const fullList = await full.listTools();
    expect(fullList.tools.length).toBeGreaterThanOrEqual(200);
    const fullTokens = tokens(fullList.tools);

    const omni = await connect('/mcp/omni');
    const meta = await omni.listTools();
    // + report_outcome, advertised on Omni by default (F15.22, ADR-016 §14)
    expect(meta.tools.map((t) => t.name)).toEqual(['search_tools', 'get_tool_schema', 'call_tool', 'report_outcome']);
    expect(meta.tools.find((t) => t.name === 'call_tool')).toMatchObject({ title: 'Call a tool' });
    expect(omni.getInstructions()).toContain('Flow: search_tools → get_tool_schema → call_tool.');

    // test agent: "what are the time punches of employee X?"
    const found = await omni.callTool({ name: 'search_tools', arguments: { query: 'listar marcações de ponto de um colaborador', limit: 5 } });
    const results = (found.structuredContent as { results: Array<{ name: string }> }).results;
    expect(results[0]!.name).toBe('rh_marcacoes_list');
    const schema = await omni.callTool({ name: 'get_tool_schema', arguments: { name: results[0]!.name } });
    expect((schema.structuredContent as any).inputSchema.properties).toHaveProperty('colaborador');
    expect((schema.structuredContent as any).description).toMatch(/ Read-only\.$/);
    const colab = up.data.colaboradores[0]!.id;
    const answer = await omni.callTool({ name: 'call_tool', arguments: { name: 'rh_marcacoes_list', arguments: { colaborador: colab, limit: 2 } } });
    expect(answer.isError).toBeFalsy();
    const items = (answer.structuredContent as { items: Array<{ colaborador_id: string }> }).items;
    expect(items.length).toBe(2);
    expect(items.every((m) => m.colaborador_id === colab)).toBe(true);

    const omniTokens = tokens(meta.tools) + tokens(found.content) + tokens(schema.content);
    const ratio = omniTokens / fullTokens;
    console.warn(`definition tokens: /mcp=${fullTokens}, omni=${omniTokens} (${(ratio * 100).toFixed(1)}%)`);
    expect(ratio).toBeLessThan(0.15);
  });

  it('call_tool goes through the same pipeline (PII, audit)', async () => {
    const omni = await connect('/mcp/omni');
    const r = await omni.callTool({ name: 'call_tool', arguments: { name: 'rh_colaborador_get', arguments: { id: up.data.colaboradores[1]!.id } } });
    expect((r.structuredContent as any).cpf).toMatch(/^\*\*\*/);
    const [ev] = await h.services.repos.audit.list(seeded.tenantId, { toolId: seeded.tools.rh_colaborador_get, limit: 1 });
    expect(ev!.subject).toBe('agente-omni');
  });

  it('search and schema honor the subject policy', async () => {
    await h.services.repos.policies.create(seeded.tenantId, { subjectType: 'role', subject: 'leitor', effect: 'allow', toolPattern: 'fin_*' });
    await h.services.registry.invalidate(seeded.tenantId);
    const leitor = await connect('/mcp/omni', {}, await h.token({ tenant: 'acme', roles: ['leitor'], sub: 'leitor-1' }));
    const r = await leitor.callTool({ name: 'search_tools', arguments: { query: 'listar marcações de ponto', limit: 10 } });
    const names = (r.structuredContent as { results: Array<{ name: string }> }).results.map((x) => x.name);
    expect(names.every((n) => n.startsWith('fin_'))).toBe(true);
    expect(errorPayload(await leitor.callTool({ name: 'get_tool_schema', arguments: { name: 'rh_marcacoes_list' } }))).toMatchObject({ error: 'TOOL_NOT_FOUND' });
    expect(errorPayload(await leitor.callTool({ name: 'call_tool', arguments: { name: 'rh_marcacoes_list', arguments: {} } }))).toMatchObject({ error: 'TOOL_NOT_FOUND' });
  });

  it('dynamic mode: found tools join the session with notifications/tools/list_changed', async () => {
    const dyn = await connect('/mcp/omni', { 'mcp-omni-mode': 'dynamic' });
    let changed = 0;
    dyn.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      changed += 1;
    });
    expect((await dyn.listTools()).tools).toHaveLength(4); // 3 meta-tools + report_outcome
    await new Promise((r) => setTimeout(r, 200)); // GET notification stream
    await dyn.callTool({ name: 'search_tools', arguments: { query: 'escalas de trabalho', limit: 2 } });
    for (let i = 0; i < 40 && changed === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(changed).toBe(1);
    const names = (await dyn.listTools()).tools.map((t) => t.name);
    expect(names).toContain('rh_escalas_list');
    expect(names).toHaveLength(6); // 4 meta-tools + 2 discovered
    const direct = await dyn.callTool({ name: 'rh_escalas_list', arguments: {} });
    expect(direct.isError).toBeFalsy();
    expect(h.services.sessions.size).toBeGreaterThanOrEqual(1);
  });

  it('meta-tools, instructions, errors and effect sentences follow the principal locale (pt-BR, es)', async () => {
    const pt = await connect('/mcp/omni', {}, await h.token({ tenant: 'acme', sub: 'agente-omni-pt', locale: 'pt-BR' }));
    const ptTools = (await pt.listTools()).tools;
    expect(ptTools.find((t) => t.name === 'search_tools')).toMatchObject({
      title: 'Buscar tools',
      description: expect.stringContaining('Busca, em linguagem natural'),
    });
    expect((ptTools.find((t) => t.name === 'get_tool_schema')!.inputSchema.properties as any).name.description).toBe('Nome exato da tool');
    expect(pt.getInstructions()).toBe('Este servidor expõe muitas tools sob demanda. Fluxo: search_tools → get_tool_schema → call_tool.');
    expect(errorPayload(await pt.callTool({ name: 'get_tool_schema', arguments: { name: 'nao_existe' } }))).toEqual({
      error: 'TOOL_NOT_FOUND',
      message: 'tool nao_existe não encontrada (use search_tools)',
    });
    const ptSchema = await pt.callTool({ name: 'get_tool_schema', arguments: { name: 'rh_marcacoes_list' } });
    expect((ptSchema.structuredContent as any).description).toMatch(/ Somente leitura\.$/);

    const es = await connect('/mcp/omni', {}, await h.token({ tenant: 'acme', sub: 'agente-omni-es', locale: 'es' }));
    const esTools = (await es.listTools()).tools;
    expect(esTools.find((t) => t.name === 'call_tool')).toMatchObject({
      title: 'Llamar una tool',
      description: expect.stringContaining('Ejecuta una tool por nombre'),
    });
    expect((esTools.find((t) => t.name === 'search_tools')!.inputSchema.properties as any).query.description).toContain('Lo que quiere hacer');
    expect(es.getInstructions()).toContain('Este servidor expone muchas tools bajo demanda.');
    expect(errorPayload(await es.callTool({ name: 'call_tool', arguments: {} }))).toEqual({ error: 'VALIDATION_ERROR', message: 'name es obligatorio' });
    // executor errors inside call_tool use the same locale
    expect(errorPayload(await es.callTool({ name: 'call_tool', arguments: { name: 'rh_marcacoes_list', arguments: { colaborador: 1 } } }))).toMatchObject({
      error: 'VALIDATION_ERROR',
      message: 'argumentos inválidos para la tool',
    });
    const esSchema = await es.callTool({ name: 'get_tool_schema', arguments: { name: 'rh_marcacao_delete' } });
    expect((esSchema.structuredContent as any).description).toMatch(/ Modifica datos \(operación destructiva\)\.$/);
  });

  it('a session cannot be used by another subject', async () => {
    const res = await fetch(`${base}/mcp/omni`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-omni-mode': 'dynamic' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }),
    });
    const sid = res.headers.get('mcp-session-id')!;
    expect(sid).toBeTruthy();
    const other = await fetch(`${base}/mcp/omni`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await h.token({ tenant: 'acme', sub: 'intruso' })}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(other.status).toBe(403);
  });
});

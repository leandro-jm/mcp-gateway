import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorPayload } from '../src/proxy/result';
import { startHarness, type Harness } from './harness';
import { mcpClient, seedRhTenant, type SeededTenant } from './seed';

describe('data plane MCP → REST (F3.1 / F3.2)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let base: string;
  let seeded: SeededTenant;
  let client: Client;
  let agentToken: string;

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    seeded = await seedRhTenant(h, up, { enable: ['rh_colaboradores_list', 'rh_colaborador_get', 'rh_marcacao_create', 'rh_marcacao_delete', 'rh_escalas_list'] });
    agentToken = await h.token({ sub: 'agente-1', roles: ['agent'], tenant: 'acme', azp: 'agent-dev' });
    client = await mcpClient(base, agentToken);
  });
  afterAll(async () => {
    await client?.close();
    await h?.teardown();
    await up?.close();
  });

  it('initialize advertises tools (listChanged) and resources', () => {
    expect(client.getServerCapabilities()).toMatchObject({ tools: { listChanged: true }, resources: {} });
    expect(client.getServerVersion()?.name).toBe('mcp-gateway');
  });

  it('tools/list returns only enabled tools, with schema and annotations', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['rh_colaborador_get', 'rh_colaboradores_list', 'rh_escalas_list', 'rh_marcacao_create', 'rh_marcacao_delete']);
    const del = tools.find((t) => t.name === 'rh_marcacao_delete')!;
    expect(del.annotations).toMatchObject({ destructiveHint: true });
    expect(del.inputSchema).toMatchObject({ type: 'object', required: ['id'] });
  });

  it('tools/list appends the effect sentence from the annotations in the principal locale', async () => {
    const descOf = (tools: Array<{ name: string; description?: string }>, name: string) => tools.find((t) => t.name === name)!.description!;
    const en = (await client.listTools()).tools;
    expect(descOf(en, 'rh_colaboradores_list')).toMatch(/ Read-only\.$/);
    expect(descOf(en, 'rh_marcacao_create')).toMatch(/ Modifies data\.$/);
    expect(descOf(en, 'rh_marcacao_delete')).toMatch(/ Modifies data \(destructive operation\)\.$/);

    const es = await mcpClient(base, await h.token({ sub: 'agente-es', roles: ['agent'], tenant: 'acme', locale: 'es' }));
    try {
      const tools = (await es.listTools()).tools;
      expect(descOf(tools, 'rh_colaboradores_list')).toMatch(/ Solo lectura\.$/);
      expect(descOf(tools, 'rh_marcacao_create')).toMatch(/ Modifica datos\.$/);
      expect(descOf(tools, 'rh_marcacao_delete')).toMatch(/ Modifica datos \(operación destructiva\)\.$/);
      expect(descOf(tools, 'rh_colaboradores_list')).not.toContain('Read-only');
      // the stored description is the same; only the suffix changes
      expect(descOf(tools, 'rh_colaboradores_list').replace(/ Solo lectura\.$/, '')).toBe(descOf(en, 'rh_colaboradores_list').replace(/ Read-only\.$/, ''));
    } finally {
      await es.close();
    }
  });

  it('GET with query and path param, with structuredContent', async () => {
    const list = await client.callTool({ name: 'rh_colaboradores_list', arguments: { size: 3, unidade_id: 'uni-1' } });
    expect(list.isError).toBeFalsy();
    const sc = list.structuredContent as { items: Array<{ id: string; unidade_id: string }>; total: number };
    expect(sc.items.length).toBeLessThanOrEqual(3);
    expect(sc.items.every((c) => c.unidade_id === 'uni-1')).toBe(true);
    const lastReq = up.requests.at(-1)!;
    expect(lastReq.url).toBe('/colaboradores?unidade_id=uni-1&size=3');
    expect(lastReq.headers.authorization).toMatch(/^Bearer fake_/);

    const id = up.data.colaboradores[2]!.id;
    const one = await client.callTool({ name: 'rh_colaborador_get', arguments: { id } });
    expect((one.structuredContent as { id: string }).id).toBe(id);

    const escalas = await client.callTool({ name: 'rh_escalas_list', arguments: {} });
    expect((escalas.structuredContent as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  it('POST with body and DELETE', async () => {
    const created = await client.callTool({
      name: 'rh_marcacao_create',
      arguments: { colaborador_id: up.data.colaboradores[0]!.id, data_hora: '2026-10-02T08:00:00-03:00', tipo: 'entrada', x_request_id: 'req-1' },
    });
    expect(created.isError).toBeFalsy();
    const marcacao = created.structuredContent as { id: string };
    expect(up.requests.at(-1)!.headers['x-request-id']).toBe('req-1');
    const del = await client.callTool({ name: 'rh_marcacao_delete', arguments: { id: marcacao.id } });
    expect(del.isError).toBeFalsy();
    expect((del.content as Array<{ text: string }>)[0]!.text).toContain('HTTP 204');
  });

  it('an upstream 4xx becomes a tool result with a useful message', async () => {
    const r = await client.callTool({ name: 'rh_colaborador_get', arguments: { id: 'nao-existe' } });
    expect(r.isError).toBe(true);
    // the upstream message is passed through untranslated
    expect(errorPayload(r)).toMatchObject({ error: 'UPSTREAM_CLIENT_ERROR', status: 404, message: 'colaborador nao-existe não encontrado' });
  });

  it('invalid arguments are rejected before the upstream (Ajv)', async () => {
    const before = up.requests.length;
    const r = await client.callTool({ name: 'rh_marcacao_create', arguments: { colaborador_id: 'x', data_hora: 'ontem', tipo: 'almoco' } });
    expect(r.isError).toBe(true);
    expect(errorPayload(r)).toMatchObject({ error: 'VALIDATION_ERROR', message: 'invalid arguments for the tool' });
    expect(JSON.stringify(errorPayload(r))).toContain('"allowed"');
    expect(up.requests.length).toBe(before);
  });

  it('errors are rendered in the principal locale (pt-BR, es)', async () => {
    const args = { colaborador_id: 'x', data_hora: 'ontem', tipo: 'almoco' };
    const pt = await mcpClient(base, await h.token({ sub: 'agente-pt', roles: ['agent'], tenant: 'acme', locale: 'pt-BR' }));
    const es = await mcpClient(base, await h.token({ sub: 'agente-es', roles: ['agent'], tenant: 'acme', locale: 'es' }));
    try {
      expect(errorPayload(await pt.callTool({ name: 'rh_marcacao_create', arguments: args }))).toMatchObject({
        error: 'VALIDATION_ERROR',
        message: 'argumentos inválidos para a tool',
      });
      expect(errorPayload(await es.callTool({ name: 'rh_marcacao_create', arguments: args }))).toMatchObject({
        error: 'VALIDATION_ERROR',
        message: 'argumentos inválidos para la tool',
      });
      // protocol errors (JSON-RPC) too
      await expect(pt.callTool({ name: 'nao_existe', arguments: {} })).rejects.toThrow(/Tool desconhecida: nao_existe/);
      await expect(es.callTool({ name: 'nao_existe', arguments: {} })).rejects.toThrow(/Tool desconocida: nao_existe/);
    } finally {
      await pt.close();
      await es.close();
    }
  });

  it('unknown or disabled tool → protocol error -32602', async () => {
    await expect(client.callTool({ name: 'nao_existe', arguments: {} })).rejects.toMatchObject({ code: -32602 });
    await expect(client.callTool({ name: 'nao_existe', arguments: {} })).rejects.toThrow(/Unknown tool: nao_existe/);
    await expect(client.callTool({ name: 'rh_marcacoes_list', arguments: {} })).rejects.toMatchObject({ code: -32602 });
  });

  it('a 5xx on GET is retried; on POST it is not', async () => {
    up.addFault({ status: 503, times: 1, pathPrefix: '/escalas' });
    const ok = await client.callTool({ name: 'rh_escalas_list', arguments: {} });
    expect(ok.isError).toBeFalsy();

    up.addFault({ status: 503, times: 1, pathPrefix: '/marcacoes' });
    const fail = await client.callTool({
      name: 'rh_marcacao_create',
      arguments: { colaborador_id: up.data.colaboradores[0]!.id, data_hora: '2026-10-02T08:00:00-03:00', tipo: 'saida' },
    });
    expect(fail.isError).toBe(true);
    expect(errorPayload(fail)).toEqual({ error: 'UPSTREAM_ERROR', status: 503, message: 'upstream service error (HTTP 503)' });
  });

  it('a per-source timeout becomes a tool error', async () => {
    await h.services.repos.sources.update(seeded.tenantId, seeded.sourceId, { settings: { timeoutMs: 200, maxRetries: 0 } });
    await h.services.registry.invalidate(seeded.tenantId);
    up.addFault({ status: 0, delayMs: 600, times: 1, pathPrefix: '/escalas' });
    const r = await client.callTool({ name: 'rh_escalas_list', arguments: {} });
    expect(r.isError).toBe(true);
    expect(errorPayload(r)).toMatchObject({ error: 'UPSTREAM_ERROR', message: 'timeout exceeded (200 ms)' });
    await h.services.repos.sources.update(seeded.tenantId, seeded.sourceId, { settings: {} });
    await h.services.registry.invalidate(seeded.tenantId);
  });

  it('no token → 401 with WWW-Authenticate (body in the Accept-Language locale); GET → 405', async () => {
    const unauthenticated = (headers: Record<string, string> = {}) =>
      fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    const res = await unauthenticated();
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('missing Authorization Bearer header');
    const pt = await unauthenticated({ 'accept-language': 'pt-BR,pt;q=0.9' });
    expect(((await pt.json()) as { error: { message: string } }).error.message).toBe('header Authorization Bearer ausente');
    expect((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${agentToken}` } })).status).toBe(405);
  });

  it('virtual server /mcp/s/:slug exposes only the selected catalog', async () => {
    await h.services.repos.virtualServers.create(seeded.tenantId, {
      slug: 'rh-leitura',
      name: 'RH leitura',
      description: 'Consultas de RH',
      toolSelector: { patterns: ['rh_colaborador*'], tools: ['rh_marcacoes_list'] },
    });
    await h.services.registry.invalidate(seeded.tenantId);
    const vs = await mcpClient(base, agentToken, '/mcp/s/rh-leitura');
    try {
      expect((await vs.listTools()).tools.map((t) => t.name).sort()).toEqual(['rh_colaborador_get', 'rh_colaboradores_list']);
      // tenant-entered instructions are never translated; tool descriptions still get the effect sentence
      expect(vs.getInstructions()).toBe('Consultas de RH');
      expect((await vs.listTools()).tools.every((t) => t.description!.endsWith(' Read-only.'))).toBe(true);
      await expect(vs.callTool({ name: 'rh_escalas_list', arguments: {} })).rejects.toMatchObject({ code: -32602 });
    } finally {
      await vs.close();
    }
    const missing = await fetch(`${base}/mcp/s/nao-existe`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(missing.status).toBe(404);
  });

  it('every call produces an audit event', async () => {
    const localeAgents = new Set(['agente-pt', 'agente-es']); // callers of the locale tests
    const events = (await h.services.repos.audit.list(seeded.tenantId, { action: 'tools/call', limit: 100 })).filter((e) => !localeAgents.has(e.subject ?? ''));
    expect(events.length).toBeGreaterThan(5);
    expect(events.every((e) => e.subject === 'agente-1' && e.clientId === 'agent-dev')).toBe(true);
    expect(events.some((e) => e.decision === 'error')).toBe(true);
  });
});

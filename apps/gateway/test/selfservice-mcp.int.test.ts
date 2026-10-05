import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness';
import { mcpClient, seedRhTenant, type SeededTenant } from './seed';

const composite = (name: string, step: string, args: string) => `
name: ${name}
description: Composta ${name}
input: { type: object, required: [colaborador_id], properties: { colaborador_id: { type: string } } }
steps:
  - id: s
    tool: ${step}
    args: ${args}
`;

describe('MCP self-service (F7b.6)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let base: string;
  let owner: string;

  const call = (method: string, url: string, body?: unknown) =>
    h.app.inject({ method: method as 'GET', url: `/admin/v1${url}`, headers: { authorization: `Bearer ${owner}`, 'x-tenant': 'acme' }, ...(body ? { payload: body as object } : {}) });

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    seeded = await seedRhTenant(h, up, { policies: [] });
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    owner = await h.token({ roles: ['tool-owner'], tenant: 'acme', groups: ['team-rh'], sub: 'owner-1' });
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
  });

  it('the owner creates the "rh-gestor" MCP with 2 composites and 3 base tools; the client sees only what is allowed', async () => {
    for (const [name, step, args] of [
      ['rh_ficha_colaborador', 'rh_colaborador_get', '{ id: "$input.colaborador_id" }'],
      ['rh_escala_colaborador', 'rh_escalas_list', '{ colaborador: "$input.colaborador_id" }'],
    ] as const) {
      const c = (await call('POST', '/composites', { source: composite(name, step, args) })).json();
      expect(c.status).toBe('valid');
      expect((await call('POST', `/tools/${c.toolId}/enable`)).statusCode).toBe(200);
    }
    const vs = await call('POST', '/virtual-servers', {
      slug: 'rh-gestor',
      name: 'RH Gestor',
      description: 'MCP para gestores de RH',
      instructions: 'Use rh_ficha_colaborador para consultar um colaborador antes de qualquer ação.',
      toolSelector: { tools: ['rh_ficha_colaborador', 'rh_escala_colaborador', 'rh_colaborador_get', 'rh_marcacoes_list', 'rh_marcacao_create'] },
      icon: 'users',
    });
    expect(vs.statusCode).toBe(201);
    expect(vs.json()).toMatchObject({ ownerTeam: 'team-rh', mode: 'full', endpoints: { mcp: 'http://gateway.test/mcp/s/rh-gestor' } });

    // policy: managers access the composites and two base tools (not the write one)
    for (const toolPattern of ['rh_ficha_colaborador', 'rh_escala_colaborador', 'rh_colaborador_get', 'rh_escalas_list', 'rh_marcacoes_list']) {
      await h.services.repos.policies.create(seeded.tenantId, { subjectType: 'group', subject: 'gestores', effect: 'allow', toolPattern });
    }
    await h.services.registry.invalidate(seeded.tenantId);

    const gestor = await mcpClient(base, await h.token({ tenant: 'acme', roles: [], groups: ['gestores'], sub: 'g-1' }), '/mcp/s/rh-gestor');
    try {
      expect(gestor.getInstructions()).toContain('rh_ficha_colaborador');
      const tools = (await gestor.listTools()).tools;
      const names = tools.map((t) => t.name).sort();
      // the effect sentence is appended to generated (openapi) descriptions only, never to human-authored composites
      expect(tools.find((t) => t.name === 'rh_colaborador_get')!.description).toMatch(/ Read-only\.$/);
      expect(tools.find((t) => t.name === 'rh_ficha_colaborador')!.description).not.toMatch(/Read-only\.$/);
      // MCP catalog ∩ policy: rh_escalas_list is allowed but outside the catalog; rh_marcacao_create is in the catalog but not allowed
      expect(names).toEqual(['rh_colaborador_get', 'rh_escala_colaborador', 'rh_ficha_colaborador', 'rh_marcacoes_list']);
      const r = await gestor.callTool({ name: 'rh_ficha_colaborador', arguments: { colaborador_id: up.data.colaboradores[0]!.id } });
      expect(r.isError).toBeFalsy();
      await expect(gestor.callTool({ name: 'rh_marcacao_create', arguments: {} })).rejects.toMatchObject({ code: -32602 });
    } finally {
      await gestor.close();
    }
  });

  it('connection snippets and omni mode', async () => {
    const vs = (await call('GET', '/virtual-servers')).json().items[0];
    const sn = (await call('GET', `/virtual-servers/${vs.id}/snippets`)).json();
    expect(sn.endpoints).toEqual({ mcp: 'http://gateway.test/mcp/s/rh-gestor', omni: 'http://gateway.test/mcp/s/rh-gestor/omni' });
    expect(sn.snippets.claude).toBe('claude mcp add --transport http rh-gestor http://gateway.test/mcp/s/rh-gestor --header "Authorization: Bearer $MCP_GATEWAY_TOKEN"');
    expect(sn.snippets.claudeJson.mcpServers['rh-gestor'].url).toBe('http://gateway.test/mcp/s/rh-gestor');
    expect(Object.keys(sn.snippets).sort()).toEqual(['claude', 'claudeJson', 'generic']);
    expect(sn).not.toHaveProperty('tokenUrl');

    await call('PATCH', `/virtual-servers/${vs.id}`, { mode: 'omni' });
    const gestor = await mcpClient(base, await h.token({ tenant: 'acme', roles: [], groups: ['gestores'], sub: 'g-1' }), '/mcp/s/rh-gestor');
    try {
      expect((await gestor.listTools()).tools.map((t) => t.name)).toEqual(['search_tools', 'get_tool_schema', 'call_tool', 'report_outcome']);
      const found = await gestor.callTool({ name: 'search_tools', arguments: { query: 'ficha do colaborador' } });
      const results = (found.structuredContent as { results: Array<{ name: string }> }).results.map((x) => x.name);
      expect(results[0]).toBe('rh_ficha_colaborador');
      expect(results).not.toContain('rh_escalas_list'); // outside this MCP catalog
    } finally {
      await gestor.close();
    }
  });

  it('an owner from another team cannot change the MCP', async () => {
    const vs = (await call('GET', '/virtual-servers')).json().items[0];
    const ops = await h.token({ roles: ['tool-owner'], tenant: 'acme', groups: ['team-ops'] });
    const r = await h.app.inject({ method: 'PATCH', url: `/admin/v1/virtual-servers/${vs.id}`, headers: { authorization: `Bearer ${ops}`, 'x-tenant': 'acme' }, payload: { name: 'x' } });
    expect(r.statusCode).toBe(403);
  });
});

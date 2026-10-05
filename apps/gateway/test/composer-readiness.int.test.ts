import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness';
import { mcpClient, seedRhTenant } from './seed';

const RESUMO = `name: rh_resumo_gerado
description: Resumo do colaborador
input: { type: object, required: [colaborador_id], properties: { colaborador_id: { type: string } } }
steps:
  - id: colab
    tool: rh_colaborador_get
    args: { id: "$input.colaborador_id" }
  - id: escalas
    tool: rh_escalas_list
    args: { colaborador: "$steps.colab.id" }
output: '{ "nome": $steps.colab.nome, "escala": $steps.escalas[0].nome }'
`;

describe('publishing readiness of a composite (F14.6)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let base: string;
  let owner: string;
  let admin: string;
  let compositeId: string;
  let compositeToolId: string;
  let vsId: string;

  const call = (method: string, url: string, body?: unknown, token = owner) =>
    h.app.inject({ method: method as 'GET', url: `/admin/v1${url}`, headers: { authorization: `Bearer ${token}`, 'x-tenant': 'acme' }, ...(body ? { payload: body as object } : {}) });
  const readiness = async (token = owner) => (await call('GET', `/composites/${compositeId}/readiness?roles=agent,gestor`, undefined, token)).json();

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    // no policies at all: default deny
    await seedRhTenant(h, up, { enable: ['rh_colaborador_get'], policies: [] });
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    owner = await h.token({ roles: ['tool-owner'], tenant: 'acme', groups: ['team-rh'], sub: 'owner-1' });
    admin = await h.adminToken('acme');
    const c = (await call('POST', '/composites', { source: RESUMO })).json();
    compositeId = c.id;
    compositeToolId = c.toolId;
    vsId = (await call('POST', '/virtual-servers', { slug: 'rh-gestor', name: 'RH gestor', toolSelector: { tools: ['rh_colaborador_get'] } })).json().id;
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
  });

  it('a fresh composite shows everything that is missing', async () => {
    const r = await readiness();
    expect(r).toMatchObject({
      composite: { id: compositeId, toolId: compositeToolId, name: 'rh_resumo_gerado', state: 'disabled', status: 'valid' },
      roles: ['agent', 'gestor'],
      canCreatePolicies: false,
      ready: false,
    });
    expect(r.steps).toEqual([
      expect.objectContaining({ id: 'colab', tool: 'rh_colaborador_get', state: 'enabled', canManage: true }),
      expect.objectContaining({ id: 'escalas', tool: 'rh_escalas_list', state: 'disabled', canManage: true }),
    ]);
    expect(r.access).toHaveLength(6);
    expect(r.access.every((a: { effect: string }) => a.effect === 'deny')).toBe(true);
    expect(r.virtualServers).toEqual([expect.objectContaining({ id: vsId, slug: 'rh-gestor', canManage: true, includes: false })]);
    expect((await readiness(admin)).canCreatePolicies).toBe(true);
  });

  it('after enabling, granting and adding to the MCP, the composite is ready and reachable', async () => {
    for (const id of [compositeToolId, (await readiness()).steps[1].toolId]) expect((await call('POST', `/tools/${id}/enable`)).statusCode).toBe(200);
    for (const tool of ['rh_resumo_gerado', 'rh_colaborador_get', 'rh_escalas_list']) {
      expect((await call('POST', '/policies', { subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: tool }, admin)).statusCode).toBe(201);
    }
    expect((await call('PATCH', `/virtual-servers/${vsId}`, { toolSelector: { tools: ['rh_colaborador_get', 'rh_resumo_gerado'] } })).statusCode).toBe(200);

    const agentOnly = (await call('GET', `/composites/${compositeId}/readiness?roles=agent`)).json();
    expect(agentOnly.access.every((a: { effect: string }) => a.effect === 'allow')).toBe(true);
    expect(agentOnly.virtualServers[0].includes).toBe(true);
    expect(agentOnly.ready).toBe(true);
    // another role is still denied
    expect((await readiness()).ready).toBe(false);

    const agent: Client = await mcpClient(base, await h.token({ tenant: 'acme', sub: 'agent-1', roles: ['agent'] }), '/mcp/s/rh-gestor');
    try {
      const listed = (await agent.listTools()).tools.map((t) => t.name);
      expect(listed).toContain('rh_resumo_gerado');
      const r = await agent.callTool({ name: 'rh_resumo_gerado', arguments: { colaborador_id: up.data.colaboradores[0]!.id } });
      expect(r.isError).toBeFalsy();
    } finally {
      await agent.close();
    }
  });

  it('owners of another team cannot inspect it', async () => {
    const stranger = await h.token({ roles: ['tool-owner'], tenant: 'acme', groups: ['team-fin'], sub: 'owner-2' });
    expect((await call('GET', `/composites/${compositeId}/readiness`, undefined, stranger)).statusCode).toBe(403);
  });
});

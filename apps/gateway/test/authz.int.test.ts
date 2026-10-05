import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorPayload } from '../src/proxy/result';
import { startHarness, type Harness } from './harness';
import { mcpClient, seedRhTenant, type SeededTenant } from './seed';

describe('per-tool authorization in the data plane (F4.3)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let base: string;
  let seeded: SeededTenant;
  let admin: string;
  const clients: Client[] = [];

  const asSubject = async (claims: Record<string, unknown>) => {
    const c = await mcpClient(base, await h.token({ tenant: 'acme', ...claims }));
    clients.push(c);
    return c;
  };
  const adminCall = (method: string, url: string, body?: unknown) =>
    h.app.inject({ method: method as 'GET', url: `/admin/v1${url}`, headers: { authorization: `Bearer ${admin}`, 'x-tenant': 'acme' }, ...(body ? { payload: body as object } : {}) });

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    admin = await h.adminToken('acme');
    seeded = await seedRhTenant(h, up, { policies: [] });
    for (const p of [
      { subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'annotation:readOnlyHint', description: 'agentes leem' },
      { subjectType: 'role', subject: 'agent', effect: 'deny', toolPattern: 'rh_escalas_list' },
      { subjectType: 'client', subject: 'ponto-bot', effect: 'allow', toolPattern: '*' },
      {
        subjectType: 'group',
        subject: 'gestores',
        effect: 'allow',
        toolPattern: 'rh_colaboradores_list',
        conditions: { args: ['args.unidade_id in claims.unidades'], rate: { limit: 2, windowSec: 60 } },
      },
    ]) {
      expect((await adminCall('POST', '/policies', p)).statusCode).toBe(201);
    }
  });
  afterAll(async () => {
    for (const c of clients) await c.close();
    await h?.teardown();
    await up?.close();
  });

  it('without any applicable rule the subject neither sees nor calls anything (default deny)', async () => {
    const c = await asSubject({ roles: ['visitante'], azp: 'x' });
    expect((await c.listTools()).tools).toEqual([]);
    await expect(c.callTool({ name: 'rh_colaboradores_list', arguments: {} })).rejects.toMatchObject({ code: -32602 });
    const [ev] = await h.services.repos.audit.list(seeded.tenantId, { decision: 'deny' });
    expect(ev).toMatchObject({ action: 'tools/call', toolName: 'rh_colaboradores_list', details: { reason: 'default_deny' } });
  });

  it('the agent sees only read tools, minus the explicit deny; cannot call writes', async () => {
    const c = await asSubject({ roles: ['agent'], azp: 'agent-dev' });
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(['rh_colaborador_get', 'rh_colaboradores_list', 'rh_marcacoes_list']);
    await expect(c.callTool({ name: 'rh_escalas_list', arguments: {} })).rejects.toMatchObject({ code: -32602 });
    await expect(
      c.callTool({ name: 'rh_marcacao_create', arguments: { colaborador_id: 'x', data_hora: '2026-10-01T08:00:00Z', tipo: 'entrada' } }),
    ).rejects.toMatchObject({ code: -32602 });
    expect((await c.callTool({ name: 'rh_colaboradores_list', arguments: { size: 1 } })).isError).toBeFalsy();
  });

  it('the client allow * does not unlock the destructive tool', async () => {
    const c = await asSubject({ roles: [], azp: 'ponto-bot' });
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain('rh_marcacao_create');
    expect(names).not.toContain('rh_marcacao_delete');
  });

  it('args constraints are re-evaluated on call and rate limit obligations are applied', async () => {
    const c = await asSubject({ roles: [], groups: ['gestores'], azp: 'portal', unidades: ['uni-1'] });
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['rh_colaboradores_list']);
    const denied = await c.callTool({ name: 'rh_colaboradores_list', arguments: { unidade_id: 'uni-3' } });
    expect(errorPayload(denied)).toMatchObject({ error: 'FORBIDDEN', details: { reason: 'conditions_not_met' } });
    expect((await c.callTool({ name: 'rh_colaboradores_list', arguments: { unidade_id: 'uni-1' } })).isError).toBeFalsy();
    expect((await c.callTool({ name: 'rh_colaboradores_list', arguments: { unidade_id: 'uni-1' } })).isError).toBeFalsy();
    const limited = await c.callTool({ name: 'rh_colaboradores_list', arguments: { unidade_id: 'uni-1' } });
    expect(errorPayload(limited)).toMatchObject({ error: 'RATE_LIMITED' });
  });

  it('simulate explains the decision and the applied rule', async () => {
    const sim = async (body: unknown) => (await adminCall('POST', '/policies/simulate', body)).json();
    const a = await sim({ subject: { roles: ['agent'] }, tool: 'rh_colaborador_get' });
    expect(a).toMatchObject({ effect: 'allow', reason: 'allow', rule: { toolPattern: 'annotation:readOnlyHint', description: 'agentes leem' } });
    const b = await sim({ subject: { roles: ['agent'] }, tool: 'rh_escalas_list' });
    expect(b).toMatchObject({ effect: 'deny', reason: 'explicit_deny', rule: { effect: 'deny', toolPattern: 'rh_escalas_list' } });
    const c = await sim({ subject: { clientId: 'ponto-bot' }, tool: 'rh_marcacao_delete' });
    expect(c).toMatchObject({ effect: 'deny', reason: 'destructive_requires_explicit_allow' });
    expect(c.trace[0].note).toContain('destructive');
    const d = await sim({ subject: { groups: ['gestores'], claims: { unidades: ['uni-1'] } }, tool: 'rh_colaboradores_list', args: { unidade_id: 'uni-2' } });
    expect(d).toMatchObject({ effect: 'deny', reason: 'conditions_not_met' });
    expect(d.explanation).toContain('args.unidade_id in claims.unidades');
  });

  it('validates conditions on create and invalidates the cache when a policy changes', async () => {
    expect((await adminCall('POST', '/policies', { subjectType: 'role', subject: 'x', effect: 'allow', toolPattern: '*', conditions: { args: ['args.a ~~ 1'] } })).statusCode).toBe(400);
    expect((await adminCall('POST', '/policies', { subjectType: 'role', subject: 'x', effect: 'allow', toolPattern: '*', conditions: { timeWindows: [{ start: '9h' }] } })).statusCode).toBe(400);

    const c = await asSubject({ roles: ['visitante'], azp: 'v' });
    expect((await c.listTools()).tools).toHaveLength(0);
    const created = await adminCall('POST', '/policies', { subjectType: 'role', subject: 'visitante', effect: 'allow', toolPattern: 'rh_escalas_list' });
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['rh_escalas_list']);
    await adminCall('DELETE', `/policies/${created.json().id}`);
    expect((await c.listTools()).tools).toHaveLength(0);
  });
});

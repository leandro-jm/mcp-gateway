import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness';
import { mcpClient, seedRhTenant, type SeededTenant } from './seed';

describe('manual tools (F7b.1)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let client: Client;
  let owner: string;

  const call = (method: string, url: string, body?: unknown, token = owner) =>
    h.app.inject({ method: method as 'GET', url: `/admin/v1${url}`, headers: { authorization: `Bearer ${token}`, 'x-tenant': 'acme' }, ...(body ? { payload: body as object } : {}) });

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    seeded = await seedRhTenant(h, up);
    owner = await h.token({ roles: ['tool-owner'], tenant: 'acme', groups: ['team-rh'], sub: 'owner-1' });
    client = await mcpClient(await h.app.listen({ port: 0, host: '127.0.0.1' }), await h.token({ tenant: 'acme' }));
  });
  afterAll(async () => {
    await client?.close();
    await h?.teardown();
    await up?.close();
  });

  const spec = () => ({
    name: 'rh_banco_horas_relatorio',
    title: 'Relatório de banco de horas',
    description: 'Saldo, créditos e débitos de banco de horas de um colaborador na competência.',
    sourceId: seeded.sourceId,
    method: 'GET',
    path: '/relatorios/banco-horas/{colaborador_id}',
    params: [
      { name: 'colaborador_id', in: 'path', description: 'Id do colaborador' },
      { name: 'competencia', in: 'query', schema: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } },
    ],
    exampleResponse: { colaborador_id: 'col-1', competencia: '2026-09', saldo_minutos: -30, creditos_minutos: 120, debitos_minutos: 150 },
  });

  it('an endpoint outside the spec becomes a manual tool that works end to end', async () => {
    const created = await call('POST', '/tools/manual', spec());
    expect(created.statusCode).toBe(201);
    const tool = created.json();
    expect(tool).toMatchObject({ kind: 'manual', state: 'disabled', annotations: { readOnlyHint: true }, ownerTeam: 'team-rh' });
    expect(tool.inputSchema.required).toEqual(['colaborador_id']);
    expect(tool.outputSchema.properties.saldo_minutos).toEqual({ type: 'integer' });

    // starts disabled: invisible
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('rh_banco_horas_relatorio');
    expect((await call('POST', `/tools/${tool.id}/enable`)).statusCode).toBe(200);

    const colab = up.data.colaboradores[3]!;
    const r = await client.callTool({ name: 'rh_banco_horas_relatorio', arguments: { colaborador_id: colab.id, competencia: '2026-08' } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ colaborador_id: colab.id, competencia: '2026-08' });
    expect(up.requests.at(-1)!.url).toBe(`/relatorios/banco-horas/${colab.id}?competencia=2026-08`);
    expect(up.requests.at(-1)!.headers.authorization).toMatch(/^Bearer fake_/); // the source credential

    const bad = await client.callTool({ name: 'rh_banco_horas_relatorio', arguments: { colaborador_id: colab.id, competencia: 'agosto' } });
    expect(bad.isError).toBe(true);
  });

  it('validates the definition and versions updates', async () => {
    const s = spec();
    expect((await call('POST', '/tools/manual', { ...s, name: 'x1', params: [] })).statusCode).toBe(400); // {colaborador_id} without a mapping
    expect((await call('POST', '/tools/manual', { ...s, name: 'x2', params: [...s.params, { name: 'other', in: 'path' }] })).statusCode).toBe(400);
    expect((await call('POST', '/tools/manual', s)).statusCode).toBe(409);
    // the source's credential belongs to its team: another team's owner cannot build on it
    const ops = await h.token({ roles: ['tool-owner'], tenant: 'acme', groups: ['team-ops'] });
    const otherSource = await call('POST', '/tools/manual', { ...s, name: 'rh_outra', ownerTeam: 'team-ops' }, ops);
    expect(otherSource.statusCode).toBe(403);
    expect(otherSource.json().message).toBe('only gateway-admin or owners of team team-rh can create tools on this source');
    const rhOwner = await h.token({ roles: ['tool-owner'], tenant: 'acme', groups: ['team-rh'], sub: 'owner-rh-manual' });
    const otherTeam = await call('POST', '/tools/manual', { ...s, name: 'rh_outra', ownerTeam: 'team-ops' }, rhOwner);
    expect(otherTeam.statusCode).toBe(400);
    expect(otherTeam.json().message).toBe('owners can only create tools for their own team');

    const id = (await h.services.repos.tools.findByName(seeded.tenantId, 'rh_banco_horas_relatorio'))!.id;
    const upd = await call('PUT', `/tools/${id}/manual`, { ...s, description: 'Banco de horas (v2)' });
    expect(upd.json()).toMatchObject({ version: 2, description: 'Banco de horas (v2)', state: 'enabled' });
  });
});

import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness';
import { mcpClient, seedRhTenant, type SeededTenant } from './seed';

const callIdOf = (r: { _meta?: unknown }) => (r._meta as Record<string, string>)['io.github.leandro-jm.mcp-gateway/call-id']!;
const structured = (r: unknown) => (r as { structuredContent: Record<string, any> }).structuredContent;

describe('report_outcome (F15.22)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let base: string;
  let token: string;

  const setMode = async (outcomeTool: string) => {
    await h.services.repos.tenants.update(seeded.tenantId, { settings: { observability: { outcomeTool } } });
    await h.services.registry.invalidate(seeded.tenantId);
  };

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    seeded = await seedRhTenant(h, up);
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    token = await h.token({ tenant: 'acme', sub: 'agent-out' });
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
  });

  it('Omni advertises it by default and links the calls of the session since the last outcome', async () => {
    const omni = await mcpClient(base, token, '/mcp/omni');
    try {
      expect((await omni.listTools()).tools.map((t) => t.name)).toContain('report_outcome');
      await omni.callTool({ name: 'call_tool', arguments: { name: 'rh_colaboradores_list', arguments: { size: 1 } } });
      await omni.callTool({ name: 'call_tool', arguments: { name: 'rh_colaborador_get', arguments: { id: up.data.colaboradores[0]!.id } } });
      const first = structured(await omni.callTool({ name: 'report_outcome', arguments: { outcome: 'success', reason_code: 'completed' } }));
      expect(first).toMatchObject({ linkedCalls: 2, tools: expect.arrayContaining(['rh_colaboradores_list', 'rh_colaborador_get']) });
      await omni.callTool({ name: 'call_tool', arguments: { name: 'rh_colaborador_get', arguments: { id: 'missing' } } });
      const second = structured(await omni.callTool({ name: 'report_outcome', arguments: { outcome: 'failure', reason_code: 'tool_error' } }));
      expect(second).toMatchObject({ linkedCalls: 1, tools: ['rh_colaborador_get'] });
      const bad = await omni.callTool({ name: 'report_outcome', arguments: { outcome: 'great' } });
      expect(bad.isError).toBe(true);
    } finally {
      await omni.close();
    }
    const [row] = (await h.services.dbHandle.pool.query("SELECT * FROM call_outcomes WHERE outcome = 'success'")).rows;
    expect(row).toMatchObject({ source: 'tool', subject: 'agent-out', reason_code: 'completed', agent_name: 'test' });
  });

  it('native endpoints only with "all"; "off" hides it everywhere', async () => {
    const native = async () => {
      const c = await mcpClient(base, token);
      try {
        return (await c.listTools()).tools.map((t) => t.name);
      } finally {
        await c.close();
      }
    };
    expect(await native()).not.toContain('report_outcome');
    await setMode('all');
    expect(await native()).toContain('report_outcome');
    await setMode('off');
    const omni = await mcpClient(base, token, '/mcp/omni');
    try {
      expect((await omni.listTools()).tools.map((t) => t.name)).not.toContain('report_outcome');
    } finally {
      await omni.close();
      await setMode('omni');
    }
  });

  it('explicit call ids must belong to the same subject; the REST endpoint works for orchestrators', async () => {
    const other = await mcpClient(base, await h.token({ tenant: 'acme', sub: 'someone-else' }));
    const mine = await mcpClient(base, token);
    try {
      const foreign = callIdOf(await other.callTool({ name: 'rh_colaboradores_list', arguments: { size: 1 } }));
      const own = callIdOf(await mine.callTool({ name: 'rh_colaboradores_list', arguments: { size: 1 } }));
      const post = (body: unknown) =>
        h.app.inject({ method: 'POST', url: '/v1/outcomes', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: body as object });
      const rejected = await post({ outcome: 'success', call_ids: [foreign] });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().message).toMatch(/another subject/);
      const ok = await post({ outcome: 'partial', reasonCode: 'wrong_data', callIds: [own] });
      expect(ok.statusCode).toBe(201);
      expect(ok.json()).toMatchObject({ linkedCalls: 1, tools: ['rh_colaboradores_list'] });
      expect((await h.app.inject({ method: 'POST', url: '/v1/outcomes', payload: { outcome: 'success' } })).statusCode).toBe(401);
    } finally {
      await other.close();
      await mine.close();
    }
  });

  it('success rate per tool is queryable and shows up in top_failing_tools', async () => {
    const admin = await h.adminToken('acme');
    const res = await h.app.inject({
      method: 'POST',
      url: '/admin/v1/analytics/query',
      headers: { authorization: `Bearer ${admin}`, 'x-tenant': 'acme' },
      payload: { metric: 'success_rate', groupBy: ['tool'], range: { last: '1h' } },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().rows as Array<{ keys: { tool: string }; value: number }>;
    expect(rows.find((r) => r.keys.tool === 'rh_colaborador_get')!.value).toBe(0.5);
    const bad = await h.app.inject({
      method: 'POST',
      url: '/admin/v1/analytics/query',
      headers: { authorization: `Bearer ${admin}`, 'x-tenant': 'acme' },
      payload: { metric: 'success_rate', groupBy: ['agent'], range: { last: '1h' } },
    });
    expect(bad.statusCode).toBe(400);
  });
});

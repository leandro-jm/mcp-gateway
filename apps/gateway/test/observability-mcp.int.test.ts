import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness';
import { mcpClient, seedRhTenant } from './seed';

const callIdOf = (r: { _meta?: unknown }) => (r._meta as Record<string, string>)['io.github.leandro-jm.mcp-gateway/call-id']!;
const structured = (r: unknown) => (r as { structuredContent: Record<string, any> }).structuredContent;

describe('observability MCP (F15.14)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let base: string;
  let reader: string;
  let failedCallId: string;
  let otherCallId: string;

  const initialize = (token: string) =>
    h.app.inject({
      method: 'POST',
      url: '/mcp/observability',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    });

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    await seedRhTenant(h, up);
    await seedRhTenant(h, up, { slug: 'other' });
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    const agent = await mcpClient(base, await h.token({ tenant: 'acme', sub: 'agent-o' }));
    const otherAgent = await mcpClient(base, await h.token({ tenant: 'other', sub: 'agent-z' }));
    try {
      for (let i = 0; i < 3; i++) await agent.callTool({ name: 'rh_colaboradores_list', arguments: { size: 5 } });
      for (let i = 0; i < 2; i++) failedCallId = callIdOf(await agent.callTool({ name: 'rh_colaborador_get', arguments: { id: 'missing' } }));
      await agent.callTool({ name: 'rh_colaborador_get', arguments: { id: up.data.colaboradores[0]!.id } });
      otherCallId = callIdOf(await otherAgent.callTool({ name: 'rh_colaboradores_list', arguments: { size: 1 } }));
    } finally {
      await agent.close();
      await otherAgent.close();
    }
    await h.services.callEvents.flush();
    await h.services.repos.rollups.rollup();
    reader = await h.token({ tenant: 'acme', sub: 'analyst', roles: ['analytics-reader'] });
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
  });

  it('lists the three tools with output schemas', async () => {
    const c = await mcpClient(base, reader, '/mcp/observability');
    try {
      const { tools } = await c.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['analytics_query', 'explain_call', 'top_failing_tools']);
      expect(tools.every((t) => t.outputSchema && t.annotations?.readOnlyHint)).toBe(true);
    } finally {
      await c.close();
    }
  });

  it('results match the Admin API', async () => {
    const c = await mcpClient(base, reader, '/mcp/observability');
    try {
      const q = { metric: 'calls', groupBy: ['tool'], range: { last: '1h' } };
      const viaMcp = structured(await c.callTool({ name: 'analytics_query', arguments: q }));
      const viaApi = (await h.app.inject({ method: 'POST', url: '/admin/v1/analytics/query', headers: { authorization: `Bearer ${reader}` }, payload: q })).json();
      expect(viaMcp.rows).toEqual(viaApi.rows);
      expect(viaMcp.rows).toEqual([
        { keys: { tool: 'rh_colaboradores_list' }, value: 3 },
        { keys: { tool: 'rh_colaborador_get' }, value: 3 },
      ]);

      const explained = structured(await c.callTool({ name: 'explain_call', arguments: { call_id: failedCallId } }));
      const apiExplained = (await h.app.inject({ method: 'GET', url: `/admin/v1/calls/${failedCallId}`, headers: { authorization: `Bearer ${reader}` } })).json();
      expect(explained).toEqual(apiExplained);
      expect(explained.call).toMatchObject({ decision: 'error', error: { code: 'UPSTREAM_CLIENT_ERROR' } });

      const top = structured(await c.callTool({ name: 'top_failing_tools', arguments: { last: '24h', group_by: 'source' } }));
      expect(top.tools).toEqual([
        expect.objectContaining({ tool: 'rh_colaborador_get', calls: 3, errors: 2, topErrorCode: 'UPSTREAM_CLIENT_ERROR', topErrorStage: 'upstream', trend: 'new', by: [{ source: 'rh', errors: 2 }] }),
      ]);
    } finally {
      await c.close();
    }
  });

  it('invalid queries and unknown calls are localized tool errors; other tenants are invisible', async () => {
    const pt = await mcpClient(base, await h.token({ tenant: 'acme', sub: 'analyst-pt', roles: ['analytics-reader'], locale: 'pt-BR' }), '/mcp/observability');
    try {
      const bad = await pt.callTool({ name: 'analytics_query', arguments: { metric: 'everything', range: { last: '1h' } } });
      expect(bad.isError).toBe(true);
      expect((bad.content as Array<{ text: string }>)[0]!.text).toContain('métrica \\"everything\\" desconhecida');
      const foreign = await pt.callTool({ name: 'explain_call', arguments: { call_id: otherCallId } });
      expect(foreign.isError).toBe(true);
      expect((foreign.content as Array<{ text: string }>)[0]!.text).toContain('NOT_FOUND');
    } finally {
      await pt.close();
    }
  });

  it('owners and agents get 403; its own calls are recorded as observability events', async () => {
    const owner = await h.token({ tenant: 'acme', sub: 'owner-o', roles: ['tool-owner'], groups: ['team-rh'] });
    expect((await initialize(owner)).statusCode).toBe(403);
    expect((await initialize(await h.token({ tenant: 'acme' }))).statusCode).toBe(403);
    expect((await initialize(await h.adminToken('acme'))).statusCode).toBe(200);
    await h.services.callEvents.flush();
    const { rows } = await h.services.dbHandle.pool.query("SELECT tool_name, kind, tool_kind FROM call_events WHERE endpoint = 'observability' AND kind = 'meta'");
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.tool_kind === 'observability')).toBe(true);
  });
});

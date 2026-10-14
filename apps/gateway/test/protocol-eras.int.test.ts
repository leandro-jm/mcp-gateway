import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CallContext } from '../src/proxy/executor';
import { startHarness, type Harness } from './harness';
import { mcpClient, modernMcpClient, seedRhTenant } from './seed';

const UI_EXT = 'io.modelcontextprotocol/ui';

describe('MCP protocol eras: 2026-07-28 and 2025 side by side (F17, ADR-021)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let base: string;
  let token: string;

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    await seedRhTenant(h, up);
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    token = await h.token({ tenant: 'acme' });
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
  });
  afterEach(() => vi.restoreAllMocks());

  function spyContexts(): CallContext[] {
    const seen: CallContext[] = [];
    const original = h.services.executor.call.bind(h.services.executor);
    vi.spyOn(h.services.executor, 'call').mockImplementation((ctx, name, args) => {
      seen.push(ctx);
      return original(ctx, name, args);
    });
    return seen;
  }

  it('lists the same catalog and returns the same result on both eras', async () => {
    const modern = await modernMcpClient(base, token);
    const legacy = await mcpClient(base, token);
    try {
      const m = (await modern.listTools()).tools.map((t) => t.name).sort();
      const l = (await legacy.listTools()).tools.map((t) => t.name).sort();
      expect(m).toEqual(l);
      expect(m).toContain('rh_colaboradores_list');

      const args = { name: 'rh_colaboradores_list', arguments: { size: 1 } };
      const rm = await modern.callTool(args);
      const rl = await legacy.callTool(args);
      expect(rm.isError).toBeFalsy();
      expect(rm.structuredContent).toEqual(rl.structuredContent);
    } finally {
      await modern.close();
      await legacy.close();
    }
  });

  it('a modern client carries its identity and capabilities in every request envelope', async () => {
    const seen = spyContexts();
    const client = await modernMcpClient(base, token, '/mcp', {
      name: 'claude-desktop',
      version: '5.1.0',
      capabilities: { extensions: { [UI_EXT]: {} } },
    });
    try {
      await client.callTool({ name: 'rh_colaboradores_list', arguments: { size: 1 } });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.client).toEqual({ era: 'modern', protocolVersion: '2026-07-28', name: 'claude-desktop', version: '5.1.0', extensions: [UI_EXT] });
      expect(seen[0]!.identity).toMatchObject({
        endpoint: 'mcp',
        sessionSource: 'principal',
        agentName: 'claude-desktop',
        agentVersion: '5.1.0',
        protocolVersion: '2026-07-28',
      });
    } finally {
      await client.close();
    }
  });

  it('a 2025 client is tagged legacy with no known capabilities', async () => {
    const seen = spyContexts();
    const client = await mcpClient(base, token);
    try {
      await client.callTool({ name: 'rh_colaboradores_list', arguments: { size: 1 } });
      expect(seen[0]!.client).toMatchObject({ era: 'legacy', extensions: [] });
    } finally {
      await client.close();
    }
  });

  it('unknown tool is a -32602 protocol error on the modern era too', async () => {
    const client = await modernMcpClient(base, token);
    try {
      await expect(client.callTool({ name: 'does_not_exist', arguments: {} })).rejects.toMatchObject({ code: -32602 });
    } finally {
      await client.close();
    }
  });

  it('isolates tenants on the modern era', async () => {
    const other = await h.token({ sub: 'user-2', tenant: 'globex' });
    const client = await modernMcpClient(base, other);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain('rh_colaboradores_list');
    } finally {
      await client.close();
    }
  });

  it('Omni serves a modern client in static mode, even when it asks for dynamic', async () => {
    const client = await modernMcpClient(base, token, '/mcp/omni', { headers: { 'mcp-omni-mode': 'dynamic' } });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['search_tools', 'get_tool_schema', 'call_tool']));
      expect(names).not.toContain('rh_colaboradores_list');
      const found = await client.callTool({ name: 'search_tools', arguments: { query: 'colaboradores' } });
      expect(found.isError).toBeFalsy();
      const r = await client.callTool({ name: 'call_tool', arguments: { name: 'rh_colaboradores_list', arguments: { size: 1 } } });
      expect(r.isError).toBeFalsy();
      // static mode: the search does not add tools to the list
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('rh_colaboradores_list');
    } finally {
      await client.close();
    }
  });

  it('the observability MCP answers a modern client', async () => {
    const analyst = await h.token({ sub: 'analyst', tenant: 'acme', roles: ['analytics-reader'] });
    const client = await modernMcpClient(base, analyst, '/mcp/observability');
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it('a modern request without credentials is rejected before reaching the SDK', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(401);
  });
});

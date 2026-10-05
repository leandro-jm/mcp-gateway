import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CallContext } from '../src/proxy/executor';
import { startHarness, type Harness } from './harness';
import { seedRhTenant, type SeededTenant } from './seed';

describe('session and agent identity (F15.4)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let base: string;
  let token: string;

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    seeded = await seedRhTenant(h, up);
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    token = await h.token({ tenant: 'acme' });
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
  });
  afterEach(() => vi.restoreAllMocks());

  async function connect(path: string, name = 'claude-code', version = '2.1.0') {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}${path}`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
    const client = new Client({ name, version });
    await client.connect(transport);
    return { client, transport };
  }

  function spyContexts(): CallContext[] {
    const seen: CallContext[] = [];
    const original = h.services.executor.call.bind(h.services.executor);
    vi.spyOn(h.services.executor, 'call').mockImplementation((ctx, name, args) => {
      seen.push(ctx);
      return original(ctx, name, args);
    });
    return seen;
  }

  it('initialize issues an mgs1_ session id and later calls carry the agent', async () => {
    const seen = spyContexts();
    const { client, transport } = await connect('/mcp');
    try {
      expect(transport.sessionId).toMatch(/^mgs1_/);
      const r1 = await client.callTool({ name: 'rh_colaboradores_list', arguments: { size: 1 } });
      const r2 = await client.callTool({ name: 'rh_colaboradores_list', arguments: { size: 1 } });
      expect(r1.isError).toBeFalsy();
      expect(r2.isError).toBeFalsy();
      expect(seen).toHaveLength(2);
      expect(seen[0]!.identity).toMatchObject({ endpoint: 'mcp', sessionSource: 'header', agentName: 'claude-code', agentVersion: '2.1.0', jsonrpcId: expect.any(String) });
      expect(seen[0]!.sessionKey).toMatch(/^s-/);
      expect(seen[0]!.sessionKey).toBe(seen[1]!.sessionKey);
    } finally {
      await client.close();
    }
  });

  it('two connections of the same token get different sessions', async () => {
    const seen = spyContexts();
    const a = await connect('/mcp', 'agent-a');
    const b = await connect('/mcp', 'agent-b');
    try {
      await a.client.callTool({ name: 'rh_colaboradores_list', arguments: { size: 1 } });
      await b.client.callTool({ name: 'rh_colaboradores_list', arguments: { size: 1 } });
      expect(seen[0]!.sessionKey).not.toBe(seen[1]!.sessionKey);
      expect(seen.map((c) => c.identity?.agentName)).toEqual(['agent-a', 'agent-b']);
    } finally {
      await a.client.close();
      await b.client.close();
    }
  });

  it('stateless Omni accepts its own mgs1_ id instead of looking up a dynamic session', async () => {
    const seen = spyContexts();
    const { client, transport } = await connect('/mcp/omni');
    try {
      expect(transport.sessionId).toMatch(/^mgs1_/);
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toContain('search_tools');
      const r = await client.callTool({ name: 'call_tool', arguments: { name: 'rh_colaboradores_list', arguments: { size: 1 } } });
      expect(r.isError).toBeFalsy();
      expect(seen[0]!.identity).toMatchObject({ endpoint: 'omni', sessionSource: 'header', agentName: 'claude-code' });
    } finally {
      await client.close();
    }
  });

  it('dynamic Omni sessions keep the agent declared on initialize', async () => {
    const seen = spyContexts();
    const { client } = await connect('/mcp/omni?mode=dynamic', 'dyn-agent');
    try {
      await client.callTool({ name: 'call_tool', arguments: { name: 'rh_colaboradores_list', arguments: { size: 1 } } });
      expect(seen[0]!.identity).toMatchObject({ endpoint: 'omni', sessionSource: 'omni', agentName: 'dyn-agent' });
    } finally {
      await client.close();
    }
  });

  it('clients without the header keep the principal session; the tenant can turn issuing off', async () => {
    const seen = spyContexts();
    await h.services.repos.tenants.update(seeded.tenantId, { settings: { observability: { issueSessionId: false } } });
    await h.services.registry.invalidate(seeded.tenantId);
    try {
      const { client, transport } = await connect('/mcp');
      try {
        expect(transport.sessionId).toBeUndefined();
        await client.callTool({ name: 'rh_colaboradores_list', arguments: { size: 1 } });
        expect(seen[0]!.identity).toMatchObject({ endpoint: 'mcp', sessionSource: 'principal' });
        expect(seen[0]!.identity?.agentName).toBeUndefined();
        expect(seen[0]!.sessionKey).toMatch(/^p-/);
      } finally {
        await client.close();
      }
    } finally {
      await h.services.repos.tenants.update(seeded.tenantId, { settings: {} });
      await h.services.registry.invalidate(seeded.tenantId);
    }
  });
});

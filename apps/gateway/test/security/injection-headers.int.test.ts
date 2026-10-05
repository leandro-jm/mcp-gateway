import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorPayload } from '../../src/proxy/result';
import { startHarness, type Harness } from '../harness';
import { mcpClient, seedRhTenant, type SeededTenant } from '../seed';

describe('security: parameter injection and sensitive headers', () => {
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let client: Client;
  let agentToken: string;

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    seeded = await seedRhTenant(h, up);
    const created = await h.app.inject({
      method: 'POST',
      url: '/admin/v1/tools/manual',
      headers: { authorization: `Bearer ${await h.adminToken('acme')}`, 'x-tenant': 'acme' },
      payload: {
        name: 'rh_eco',
        description: 'eco de diagnóstico',
        sourceId: seeded.sourceId,
        method: 'GET',
        path: '/debug/eco/{valor}',
        params: [
          { name: 'valor', in: 'path' },
          { name: 'filtro', in: 'query' },
          { name: 'X-Trace', in: 'header' },
        ],
        ownerTeam: 'team-rh',
      },
    });
    await h.services.repos.tools.setState(seeded.tenantId, created.json().id, 'disabled', 'enabled');
    await h.services.registry.invalidate(seeded.tenantId);
    agentToken = await h.token({ tenant: 'acme', sub: 'agent-sec' });
    client = await mcpClient(await h.app.listen({ port: 0, host: '127.0.0.1' }), agentToken);
  });
  afterAll(async () => {
    await client?.close();
    await h?.teardown();
    await up?.close();
  });

  const eco = async (args: Record<string, unknown>) => client.callTool({ name: 'rh_eco', arguments: args });
  /** The echo tool has no output schema: the body comes as JSON text. */
  const body = (r: unknown) => JSON.parse(((r as { content: Array<{ text: string }> }).content[0]!).text) as Record<string, any>;

  it('path params do not navigate to another resource', async () => {
    for (const valor of ['a/b#c', 'x?admin=1', '2026/10/01']) {
      const r = await eco({ valor });
      expect(r.isError).toBeFalsy();
      expect(body(r).valor).toBe(valor); // arrived as a single segment
    }
    // `.`/`..` segments are refused even when encoded: upstreams that decode %2F would traverse
    for (const valor of ['..', '.', '../colaboradores', '../../admin?x=1', 'a\\..\\b']) {
      expect(errorPayload(await eco({ valor }))).toMatchObject({ error: 'VALIDATION_ERROR' });
    }
  });

  it('the query does not inject extra parameters', async () => {
    const r = await eco({ valor: 'x', filtro: 'a&admin=true&size=99999' });
    expect(body(r).query).toEqual({ filtro: 'a&admin=true&size=99999' });
  });

  it('a header param with a line break is rejected (CRLF injection)', async () => {
    expect(errorPayload(await eco({ valor: 'x', x_trace: 'ok\r\nX-Admin: 1' }))).toMatchObject({ error: 'VALIDATION_ERROR' });
  });

  it('arguments outside the schema are refused (no arbitrary header/param)', async () => {
    expect(errorPayload(await eco({ valor: 'x', authorization: 'Bearer x' }))).toMatchObject({ error: 'VALIDATION_ERROR' });
  });

  it("the agent's token is never forwarded upstream; upstream headers never reach the agent", async () => {
    const r = await eco({ valor: 'x', x_trace: 'abc' });
    const echoed = body(r).headers as Record<string, string>;
    // the upstream received the gateway's credential, not the agent's token...
    expect(up.requests.at(-1)!.headers.authorization).toMatch(/^Bearer fake_/);
    // ...and the echo of that credential never reaches the agent
    expect(echoed.authorization).toBe('[credential]');
    expect(JSON.stringify(echoed)).not.toContain(agentToken);
    expect(echoed['x-trace']).toBe('abc');
    expect(echoed).not.toHaveProperty('mcp-session-id');
    const text = JSON.stringify(r);
    expect(text).not.toContain('segredo-do-upstream');
    expect(text).not.toContain('token-interno-do-upstream');
  });
});

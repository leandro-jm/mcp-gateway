import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeDecisions } from './fake-decisions';
import { startHarness, startInfra, type Harness, type Infra } from './harness';
import { routerEvents, seedSyntheticTenant, setProvider, setRouter } from './router-helpers';
import { mcpClient } from './seed';

/**
 * The router is optional (ADR-025): with the platform switch, the tenant switch or the point
 * switch off, the data plane behaves exactly as without it and the provider is never called.
 */
describe('tool router off = behavior without the router (F19.4)', () => {
  let infra: Infra;
  let off: Harness;
  let on: Harness;
  let tenantId: string;
  const fake = new FakeDecisions().forbid();
  const clients: Client[] = [];
  const bases: Record<string, string> = {};

  beforeAll(async () => {
    infra = await startInfra();
    off = await startHarness({ infra, decisions: fake.factory });
    on = await startHarness({ infra, env: { TOOL_ROUTER_ENABLED: 'true' }, decisions: fake.factory });
    bases.off = await off.app.listen({ port: 0, host: '127.0.0.1' });
    bases.on = await on.app.listen({ port: 0, host: '127.0.0.1' });
    tenantId = await seedSyntheticTenant(on, 'acme');
    await setProvider(on, tenantId);
  });
  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => undefined);
    await off?.teardown();
    await on?.teardown();
    await infra?.stop();
  });

  /** What an agent sees: search order and list of tools, on one harness. */
  async function observe(h: Harness, which: 'off' | 'on') {
    await h.services.registry.invalidate(tenantId);
    const token = await h.token({ tenant: 'acme', sub: `agente-${which}` });
    const omni = await mcpClient(bases[which]!, token, '/mcp/omni');
    const mcp = await mcpClient(bases[which]!, token);
    clients.push(omni, mcp);
    const search = await omni.callTool({ name: 'search_tools', arguments: { query: 'quando o colaborador vai tirar férias?', limit: 5 } });
    const list = await mcp.listTools();
    return { search: search.structuredContent, list: list.tools.map((t) => t.name) };
  }

  it('the platform switch off does not even create the router', async () => {
    expect(off.services.router).toBeUndefined();
    expect(on.services.router).toBeDefined();
  });

  it('platform off, tenant off and point off all match the baseline and never call the provider', async () => {
    await setRouter(on, tenantId, { enabled: true, rerank: { enabled: true }, shortlist: { enabled: true }, gate: { enabled: true } });
    const baseline = await observe(off, 'off');
    expect(baseline.list).toHaveLength(200);

    await setRouter(on, tenantId, { enabled: false, rerank: { enabled: true }, shortlist: { enabled: true }, gate: { enabled: true } });
    expect(await observe(on, 'on')).toEqual(baseline);

    await setRouter(on, tenantId, { enabled: true, rerank: { enabled: false } });
    expect(await observe(on, 'on')).toEqual(baseline);

    expect(fake.requests).toHaveLength(0);
    const events = await routerEvents(on, tenantId);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.plugins === null && e.gate === null && e.plugins_ms === null)).toBe(true);
  });
});

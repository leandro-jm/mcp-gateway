import type { DecisionRequest } from '@mcp-gateway/tool-router';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INTENT_META_KEY } from '../src/mcp/call-context';
import { errorPayload } from '../src/proxy/result';
import { FakeDecisions } from './fake-decisions';
import { startHarness, type Harness } from './harness';
import { routerEvents, seedSyntheticTenant, setProvider, setRouter } from './router-helpers';
import { modernMcpClient } from './seed';

const CPF = '529.982.247-25';

/** Namespace choice by namespace names (options are opaque ids described as `<ns>: N tools, …`). */
function pick(weights: Record<string, number>) {
  return (req: DecisionRequest) => {
    const q = req.questions[0]!;
    if (q.type !== 'choice') return undefined;
    const probabilities: Record<string, number> = {};
    for (const c of q.choices) {
      const ns = c.description.split(':')[0]!;
      if (weights[ns] !== undefined) probabilities[c.value] = weights[ns];
    }
    const best = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
    return best ? { type: 'choice' as const, choice: best[0], probabilities, confidence: best[1] } : { type: 'choice' as const, choice: 'none', probabilities: { none: 1 } };
  };
}

describe('tool router: shortlist on tools/list (F19.7)', () => {
  let h: Harness;
  let base: string;
  let tenantId: string;
  let token: string;
  const fake = new FakeDecisions();
  const clients: Array<{ close(): Promise<void> }> = [];
  const ferias = ['rh_ferias_list', 'rh_ferias_get', 'rh_ferias_create', 'rh_ferias_update', 'rh_ferias_delete'];
  const marcacoes = ferias.map((n) => n.replace('ferias', 'marcacoes'));

  beforeAll(async () => {
    h = await startHarness({ env: { TOOL_ROUTER_ENABLED: 'true' }, decisions: fake.factory });
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    tenantId = await seedSyntheticTenant(h, 'acme');
    await setProvider(h, tenantId);
    await setRouter(h, tenantId, { enabled: true, rerank: { enabled: false }, shortlist: { enabled: true, minTools: 2 } });
    token = await h.token({ tenant: 'acme', sub: 'agente-lista' });
  });
  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => undefined);
    await h?.teardown();
  });
  beforeEach(() => fake.reset());

  const legacy = async (headers: Record<string, string> = {}, tk = token) => {
    const c = new Client({ name: 'agente-teste', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tk}`, ...headers } } }));
    clients.push(c);
    return c;
  };

  it('keeps the namespaces chosen for the header intent (percent-encoded, PII redacted)', async () => {
    fake.answer({ namespace: pick({ ferias: 0.6, marcacoes: 0.35, colaboradores: 0.05 }) });
    const c = await legacy({ 'mcp-gateway-intent': encodeURIComponent(`férias e ponto do CPF ${CPF}`) });
    const { tools } = await c.listTools();
    // namespaces in probability order; tools of a namespace in catalog order
    const names = tools.map((t) => t.name);
    expect(names.slice(0, 5).sort()).toEqual([...ferias].sort());
    expect(names.slice(5).sort()).toEqual([...marcacoes].sort());
    expect(fake.requests[0]!.input).toContain('férias e ponto do CPF');
    expect(fake.requests[0]!.input).not.toContain(CPF);

    const [ev] = (await routerEvents(h, tenantId, 'list')).slice(-1);
    expect(ev!.plugins).toEqual([expect.objectContaining({ point: 'shortlist', decision: 'applied', reason: 'ok', kept: 10, candidates: 40 })]);
    expect(ev!.meta.fullCatalogTokens).toBeGreaterThan(5 * ev!.catalog_tokens!);
    expect(ev!.meta.queryHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(ev)).not.toContain('férias');
  });

  it('the request _meta intent wins over the header, on both protocol eras', async () => {
    fake.answer({ namespace: pick({ escalas: 0.95 }) });
    const c = await legacy({ 'mcp-gateway-intent': 'ferias' });
    const viaMeta = await c.listTools({ _meta: { [INTENT_META_KEY]: 'turnos e escalas de trabalho' } } as never);
    expect(viaMeta.tools.map((t) => t.name).sort()).toEqual(['rh_escalas_create', 'rh_escalas_delete', 'rh_escalas_get', 'rh_escalas_list', 'rh_escalas_update']);
    expect(fake.requests[0]!.input).toContain('turnos e escalas');

    const modern = await modernMcpClient(base, token, '/mcp', { headers: { 'mcp-gateway-intent': 'escalas' } });
    clients.push(modern);
    expect((await modern.listTools()).tools.map((t) => t.name)).toHaveLength(5);
  });

  it('without an intent, or when the provider fails, the list is the full one', async () => {
    fake.forbid();
    const plain = await legacy();
    expect((await plain.listTools()).tools).toHaveLength(200);
    expect(fake.requests).toHaveLength(0);
    const [ev] = (await routerEvents(h, tenantId, 'list')).slice(-1);
    expect(ev!.plugins![0]).toMatchObject({ decision: 'skipped', reason: 'no_intent' });

    fake.answer(new Error('provider down'));
    const c = await legacy({ 'mcp-gateway-intent': 'férias de outro assunto' });
    expect((await c.listTools()).tools).toHaveLength(200);
  });

  it('never lists a tool the policy hides, and a tool outside the shortlist stays callable', async () => {
    await h.services.repos.policies.create(tenantId, { subjectType: 'role', subject: 'financeiro', effect: 'allow', toolPattern: 'fin_*' });
    await h.services.registry.invalidate(tenantId);
    fake.answer({ namespace: pick({ ferias: 0.9, pagamentos: 0.1 }) });
    const fin = await legacy({ 'mcp-gateway-intent': 'férias' }, await h.token({ tenant: 'acme', roles: ['financeiro'], sub: 'fin-1' }));
    const names = (await fin.listTools()).tools.map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n.startsWith('fin_'))).toBe(true);
    const offered = (fake.requests[0]!.questions[0] as { choices: Array<{ description: string }> }).choices.map((c) => c.description);
    expect(offered.some((d) => d.startsWith('ferias:'))).toBe(false);

    fake.answer({ namespace: pick({ ferias: 0.95 }) });
    const c = await legacy({ 'mcp-gateway-intent': 'férias' });
    expect((await c.listTools()).tools.map((t) => t.name)).not.toContain('fin_pagamentos_list');
    const r = await c.callTool({ name: 'fin_pagamentos_list', arguments: {} });
    expect(errorPayload(r as never).error).not.toBe('TOOL_NOT_FOUND');
  });
});

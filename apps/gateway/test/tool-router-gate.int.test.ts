import type { JsonObject } from '@mcp-gateway/db';
import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { infer, META_KEYS, type ToolLike } from '@mcp-ui-kit/view-spec';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { errorPayload } from '../src/proxy/result';
import { FakeDecisions } from './fake-decisions';
import { startHarness, type Harness } from './harness';
import { routerEvents, setProvider, setRouter } from './router-helpers';
import { mcpClient, modernMcpClient, seedRhTenant, type SeededTenant } from './seed';

const CPF = '529.982.247-25';
const UI = { capabilities: { extensions: { 'io.modelcontextprotocol/ui': {} } } };
const risk = (probability: number) => ({ risky: { type: 'predicate' as const, probability } });

describe('tool router: risk gate on tools/call (F19.8)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let base: string;
  let token: string;
  const fake = new FakeDecisions();
  const deletes = () => up.requests.filter((r) => r.method === 'DELETE').length;
  const gate = (extra: JsonObject = {}) => setRouter(h, seeded.tenantId, { enabled: true, rerank: { enabled: false }, gate: { enabled: true, ...extra } });

  beforeAll(async () => {
    h = await startHarness({ env: { TOOL_ROUTER_ENABLED: 'true' }, decisions: fake.factory });
    up = await startFakeUpstream();
    seeded = await seedRhTenant(h, up);
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    await setProvider(h, seeded.tenantId);
    token = await h.token({ tenant: 'acme', sub: 'agente-gate' });
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
  });
  beforeEach(async () => {
    fake.reset();
    await gate();
  });

  const call = async (name: string, args: Record<string, unknown>, tk = token) => {
    const c = await mcpClient(base, tk);
    try {
      return await c.callTool({ name, arguments: args });
    } finally {
      await c.close();
    }
  };

  it('a high risk denies the call before the upstream and is recorded', async () => {
    fake.answer(risk(0.95));
    const before = deletes();
    const r = await call('rh_marcacao_delete', { id: up.data.marcacoes[0]!.id });
    expect(r.isError).toBe(true);
    expect(errorPayload(r as never)).toMatchObject({ error: 'FORBIDDEN' });
    expect((r.content as Array<{ text: string }>)[0]!.text).toContain('the gateway blocked this call of');
    expect(deletes()).toBe(before);

    const [ev] = (await routerEvents(h, seeded.tenantId, 'tool')).slice(-1);
    expect(ev).toMatchObject({ tool_name: 'rh_marcacao_delete', decision: 'deny', error_code: 'FORBIDDEN' });
    expect(ev!.gate).toEqual({ required: true, outcome: 'deny', reason: 'ok' });
    expect(ev!.plugins).toEqual([expect.objectContaining({ plugin: 'decision-model', point: 'gate', decision: 'deny', reason: 'ok' })]);
    const [audit] = await h.services.repos.audit.list(seeded.tenantId, { toolId: seeded.tools.rh_marcacao_delete, limit: 1 });
    expect(audit).toMatchObject({ decision: 'deny', details: expect.objectContaining({ reason: 'router_gate' }) });
  });

  it('a medium risk without a confirmation UI is denied with a localized request to confirm', async () => {
    fake.answer(risk(0.6));
    const target = { id: up.data.marcacoes[0]!.id };
    const texts = [];
    for (const locale of ['en', 'pt-BR', 'es'] as const) {
      const r = await call('rh_marcacao_delete', target, await h.token({ tenant: 'acme', sub: `gate-${locale}`, locale }));
      texts.push((r.content as Array<{ text: string }>)[0]!.text);
    }
    expect(texts[0]).toContain('needs confirmation by the user');
    expect(texts[1]).toContain('precisa de confirmação do usuário');
    expect(texts[2]).toContain('necesita la confirmación del usuario');

    await gate({ onConfirmWithoutUi: 'allow' });
    const before = deletes();
    expect((await call('rh_marcacao_delete', target)).isError).toBeFalsy();
    expect(deletes()).toBe(before + 1);
  });

  it('read-only tools are outside the default scope', async () => {
    fake.forbid();
    expect((await call('rh_colaboradores_list', { size: 1 })).isError).toBeFalsy();
    const [ev] = (await routerEvents(h, seeded.tenantId, 'tool')).slice(-1);
    expect(ev).toMatchObject({ tool_name: 'rh_colaboradores_list', plugins: null, gate: null });
  });

  it('a provider timeout follows onError', async () => {
    fake.answer((_req, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason))));
    await gate({ timeoutMs: 100 });
    const before = deletes();
    expect((await call('rh_marcacao_delete', { id: up.data.marcacoes[0]!.id })).isError).toBeFalsy();
    expect(deletes()).toBe(before + 1);
    let [ev] = (await routerEvents(h, seeded.tenantId, 'tool')).slice(-1);
    expect(ev!.plugins![0]).toMatchObject({ point: 'gate', decision: 'allow', reason: 'timeout' });

    await gate({ timeoutMs: 100, onError: 'deny' });
    expect(errorPayload((await call('rh_marcacao_delete', { id: up.data.marcacoes[0]!.id })) as never)).toMatchObject({ error: 'FORBIDDEN' });
    [ev] = (await routerEvents(h, seeded.tenantId, 'tool')).slice(-1);
    expect(ev!.gate).toMatchObject({ outcome: 'deny', reason: 'timeout' });
  });

  it('the provider gets redacted arguments (or names only) and the event keeps none', async () => {
    fake.answer(risk(0.1));
    await call('rh_marcacao_delete', { id: CPF });
    expect(fake.requests[0]!.input).toContain('"id":');
    expect(fake.requests[0]!.input).not.toContain(CPF);

    await gate({ argsMode: 'none' });
    await call('rh_marcacao_delete', { id: 'marcacao-secreta-123' });
    expect(fake.requests[1]!.input).toContain('["id"]');
    expect(fake.requests[1]!.input).not.toContain('marcacao-secreta-123');

    const events = await routerEvents(h, seeded.tenantId, 'tool');
    expect(JSON.stringify(events)).not.toContain(CPF);
    expect(JSON.stringify(events)).not.toContain('marcacao-secreta-123');
  });

  it('a human confirmation through the plan view (ADR-022) skips the provider', async () => {
    const t = await h.services.repos.tools.get(seeded.tenantId, seeded.tools.rh_marcacao_delete!);
    const tool: ToolLike = { name: t.name, inputSchema: t.inputSchema, ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}), annotations: t.annotations };
    await h.services.repos.toolViews.upsert(seeded.tenantId, t.id, infer(tool)! as unknown as JsonObject, 'active');
    await h.services.registry.invalidate(seeded.tenantId);
    fake.forbid();
    const ui = await modernMcpClient(base, token, '/mcp', UI);
    try {
      const target = { id: up.data.marcacoes[1]!.id };
      const first = await ui.callTool({ name: 'rh_marcacao_delete', arguments: target });
      const confirmToken = (first._meta?.[META_KEYS.views] as { confirmToken: string }).confirmToken;
      const before = deletes();
      const confirmed = await ui.callTool({ name: 'rh_marcacao_delete', arguments: target, _meta: { [META_KEYS.confirm]: confirmToken } });
      expect(confirmed.isError).toBeFalsy();
      expect(deletes()).toBe(before + 1);
      expect(fake.requests).toHaveLength(0);
      const [ev] = (await routerEvents(h, seeded.tenantId, 'tool')).slice(-1);
      expect(ev!.plugins![0]).toMatchObject({ point: 'gate', decision: 'allow', reason: 'human_confirmed' });
    } finally {
      await ui.close();
      await h.services.repos.toolViews.upsert(seeded.tenantId, t.id, infer(tool)! as unknown as JsonObject, 'disabled');
      await h.services.registry.invalidate(seeded.tenantId);
    }
  });
});

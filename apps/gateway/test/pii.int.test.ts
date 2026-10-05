import { findValueMatches } from '@mcp-gateway/redaction';
import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorPayload } from '../src/proxy/result';
import { startHarness, type Harness } from './harness';
import { mcpClient, seedRhTenant, type SeededTenant } from './seed';

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join('\n');

describe('PII redaction no data plane (F5.3 / F5.4)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let base: string;
  let seeded: SeededTenant;
  let client: Client;
  let admin: string;

  const adminCall = (method: string, url: string, body?: unknown) =>
    h.app.inject({ method: method as 'GET', url: `/admin/v1${url}`, headers: { authorization: `Bearer ${admin}`, 'x-tenant': 'acme' }, ...(body ? { payload: body as object } : {}) });

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream({ colaboradores: 50 });
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    admin = await h.adminToken('acme');
    seeded = await seedRhTenant(h, up);
    client = await mcpClient(base, await h.token({ tenant: 'acme' }));
  });
  afterAll(async () => {
    await client?.close();
    await h?.teardown();
    await up?.close();
  });

  it('with the default policy no fixture returns CPF, salary or e-mail in clear text', async () => {
    const outputs: string[] = [];
    const list = await client.callTool({ name: 'rh_colaboradores_list', arguments: { size: 50 } });
    outputs.push(text(list), JSON.stringify(list.structuredContent));
    for (const c of up.data.colaboradores.slice(0, 5)) {
      const one = await client.callTool({ name: 'rh_colaborador_get', arguments: { id: c.id } });
      outputs.push(text(one), JSON.stringify(one.structuredContent));
    }
    outputs.push(text(await client.callTool({ name: 'rh_marcacoes_list', arguments: { limit: 50 } })));
    outputs.push(text(await client.callTool({ name: 'rh_escalas_list', arguments: {} })));
    const all = outputs.join('\n');

    for (const c of up.data.colaboradores) {
      expect(all).not.toContain(c.cpf);
      expect(all).not.toContain(c.email);
      expect(all).not.toContain(String(c.salario));
      expect(all).not.toContain(c.pis);
    }
    expect(findValueMatches(all).filter((m) => ['cpf', 'email', 'pis'].includes(m.detector.id))).toEqual([]);
    expect(all).not.toMatch(/"salario"/);
    const first = (list.structuredContent as { items: Array<Record<string, unknown>> }).items[0]!;
    expect(first.cpf).toMatch(/^\*\*\*\.\d{3}\.\d{3}-\*\*$/);
    expect(first).not.toHaveProperty('salario');
    expect(first.nome).toBe(up.data.colaboradores[0]!.nome);
  });

  it('counts redactions in the audit and advertises a compatible schema', async () => {
    const [ev] = await h.services.repos.audit.list(seeded.tenantId, { toolId: seeded.tools.rh_colaborador_get, limit: 1 });
    expect(ev!.redactionsCount).toBeGreaterThan(5);
    const tool = (await client.listTools()).tools.find((t) => t.name === 'rh_colaborador_get')!;
    expect((tool.outputSchema as any).properties.salario.type).toContain('string');
  });

  it('upstream errors also go through redaction', async () => {
    // the upstream echoes the id in the 404 message: "colaborador 529.982.247-25 não encontrado"
    const r = await client.callTool({ name: 'rh_colaborador_get', arguments: { id: '529.982.247-25' } });
    expect(errorPayload(r)).toMatchObject({ status: 404, message: 'colaborador ***.982.247-** não encontrado' });
    expect(text(r)).not.toContain('529.982.247-25');
  });

  it('"find employee → record punch" flow with a tokenized CPF, without the real CPF reaching the agent', async () => {
    expect((await adminCall('POST', '/pii-rules', { scope: 'global', detector: 'cpf', strategy: 'tokenize' })).statusCode).toBe(201);
    const colab = up.data.colaboradores[7]!;
    const got = await client.callTool({ name: 'rh_colaborador_get', arguments: { id: colab.id } });
    const token = (got.structuredContent as { cpf: string }).cpf;
    expect(token).toMatch(/^pii_tok_[a-f0-9]{24}$/);
    expect(text(got)).not.toContain(colab.cpf);

    const created = await client.callTool({
      name: 'rh_marcacao_create',
      arguments: { colaborador_id: colab.id, cpf: token, data_hora: '2026-10-03T08:00:00-03:00', tipo: 'entrada' },
    });
    expect(created.isError).toBeFalsy();
    // the upstream received the real CPF (it validates it and would answer 422 on a mismatch)
    expect((up.requests.at(-1)!.body as { cpf: string }).cpf).toBe(colab.cpf);
    // nothing of the real value in clear text in the vault
    const vault = JSON.stringify((await h.services.dbHandle.pool.query('SELECT * FROM pii_tokens')).rows);
    expect(vault).not.toContain(colab.cpf);
  });

  it('a token cannot be used in a field of another type, from another tenant or when expired', async () => {
    const colab = up.data.colaboradores[8]!;
    const token = ((await client.callTool({ name: 'rh_colaborador_get', arguments: { id: colab.id } })).structuredContent as { cpf: string }).cpf;
    const base = { colaborador_id: colab.id, data_hora: '2026-10-03T08:00:00-03:00', tipo: 'entrada' };

    const wrongField = await client.callTool({ name: 'rh_marcacao_create', arguments: { ...base, origem: token } });
    expect(errorPayload(wrongField)).toMatchObject({
      error: 'VALIDATION_ERROR',
      message: 'PII token (cpf) cannot be used in field origem',
      details: { field: 'origem', detector: 'cpf' },
    });

    const fake = await client.callTool({ name: 'rh_marcacao_create', arguments: { ...base, cpf: 'pii_tok_' + '0'.repeat(24) } });
    expect(errorPayload(fake)).toMatchObject({ error: 'VALIDATION_ERROR', message: 'invalid or expired PII token', details: { field: 'cpf' } });

    // another tenant with the same upstream does not resolve the first one's token
    await seedRhTenant(h, up, { slug: 'beta' });
    const other = await mcpClient(base_(), await h.token({ tenant: 'beta' }));
    try {
      const r = await other.callTool({ name: 'rh_marcacao_create', arguments: { ...base, cpf: token } });
      expect(errorPayload(r)).toMatchObject({ message: 'invalid or expired PII token' });
    } finally {
      await other.close();
    }

    await h.services.dbHandle.pool.query("UPDATE pii_tokens SET expires_at = now() - interval '1 minute' WHERE token = $1", [token]);
    const expired = await client.callTool({ name: 'rh_marcacao_create', arguments: { ...base, cpf: token } });
    expect(errorPayload(expired)).toMatchObject({ message: 'invalid or expired PII token' });
    // rendered in the principal locale
    const pt = await mcpClient(base_(), await h.token({ tenant: 'acme', sub: 'agente-pii-pt', locale: 'pt-BR' }));
    try {
      const r = await pt.callTool({ name: 'rh_marcacao_create', arguments: { ...base, cpf: token } });
      expect(errorPayload(r)).toMatchObject({ message: 'token de PII inválido ou expirado', details: { field: 'cpf' } });
    } finally {
      await pt.close();
    }
  });

  it('a token only goes back to the subject it was shown to (same tenant)', async () => {
    const colab = up.data.colaboradores[9]!;
    const token = ((await client.callTool({ name: 'rh_colaborador_get', arguments: { id: colab.id } })).structuredContent as { cpf: string }).cpf;
    expect(token).toMatch(/^pii_tok_/);
    const args = { colaborador_id: colab.id, cpf: token, data_hora: '2026-10-03T09:00:00-03:00', tipo: 'entrada' };
    const other = await mcpClient(base_(), await h.token({ tenant: 'acme', sub: 'outro-agente-pii' }));
    try {
      expect(errorPayload(await other.callTool({ name: 'rh_marcacao_create', arguments: args }))).toMatchObject({ message: 'invalid or expired PII token' });
      // once the other subject sees the same value, the same token works for it too
      await other.callTool({ name: 'rh_colaborador_get', arguments: { id: colab.id } });
      expect((await other.callTool({ name: 'rh_marcacao_create', arguments: args })).isError).toBeFalsy();
    } finally {
      await other.close();
    }
  });

  it('rule preview and validation in the Admin API', async () => {
    const prev = await adminCall('POST', '/pii-rules/preview', {
      payload: { cpf: '529.982.247-25', salario: 10, obs: 'mail ana@x.com' },
      rules: [{ scope: 'global', detector: 'cpf', strategy: 'hash' }],
    });
    expect(prev.json()).toMatchObject({ redacted: { cpf: expect.stringMatching(/^pii_h_/), obs: 'mail a***@x***.com' }, count: 3 });
    expect((await adminCall('POST', '/pii-rules', { scope: 'tool', detector: 'cpf', strategy: 'mask' })).statusCode).toBe(400);
    expect((await adminCall('POST', '/pii-rules', { scope: 'global', detector: 'xyz', strategy: 'mask' })).statusCode).toBe(400);
    expect((await adminCall('POST', '/pii-rules', { scope: 'global', detector: 'field', strategy: 'mask' })).statusCode).toBe(400);
    expect((await adminCall('GET', '/pii-detectors')).json().items.length).toBeGreaterThan(10);
  });

  function base_() {
    return base;
  }
});

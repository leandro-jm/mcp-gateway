import { findValueMatches } from '@mcp-gateway/redaction';
import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness';
import { mcpClient, seedRhTenant, type SeededTenant } from './seed';

describe('LGPD subject index (F15.11)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let base: string;
  let admin: string;

  const lookup = (body: Record<string, unknown>, token = admin, tenant = 'acme') =>
    h.app.inject({ method: 'POST', url: '/admin/v1/lgpd/subject-access', headers: { authorization: `Bearer ${token}`, 'x-tenant': tenant }, payload: body });

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    seeded = await seedRhTenant(h, up);
    await seedRhTenant(h, up, { slug: 'other' });
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    admin = await h.adminToken('acme');
    const agent = await mcpClient(base, await h.token({ tenant: 'acme', sub: 'agent-lgpd', azp: 'bot-lgpd' }));
    try {
      const colab = up.data.colaboradores[3]!;
      await agent.callTool({ name: 'rh_colaborador_get', arguments: { id: colab.id } }); // CPF in the response
      await agent.callTool({ name: 'rh_colaboradores_list', arguments: { nome: up.data.colaboradores[5]!.email } }); // e-mail in the arguments
    } finally {
      await agent.close();
    }
    await h.services.callEvents.flush();
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
  });

  it('finds who accessed a subject, whatever the CPF formatting', async () => {
    const cpf = up.data.colaboradores[3]!.cpf;
    const digits = cpf.replace(/\D/g, '');
    const formatted = `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
    const a = (await lookup({ detector: 'cpf', value: formatted })).json();
    const b = (await lookup({ detector: 'cpf', value: digits })).json();
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.total).toBeGreaterThanOrEqual(1);
    expect(a.matches[0]).toMatchObject({ tool: 'rh_colaborador_get', subject: 'agent-lgpd', clientId: 'bot-lgpd', agentName: 'test', direction: 'response' });
    expect(a.summary.agents).toEqual([{ value: 'test', calls: a.total }]);
  });

  it('indexes identifiers the agent sent in the arguments', async () => {
    const r = (await lookup({ detector: 'email', value: up.data.colaboradores[5]!.email.toUpperCase() })).json();
    expect(r.matches.some((m: { direction: string; tool: string }) => m.direction === 'request' && m.tool === 'rh_colaboradores_list')).toBe(true);
  });

  it('stores no clear-text identifier and keys fingerprints per tenant', async () => {
    const rows = (await h.services.dbHandle.pool.query('SELECT ts, tenant_id, call_id, detector, direction, subject, client_id, agent_name, tool_name, decision FROM call_subject_refs')).rows;
    expect(rows.length).toBeGreaterThan(0);
    const dump = JSON.stringify(rows);
    expect(findValueMatches(dump).filter((m) => ['cpf', 'cnpj', 'pis', 'email'].includes(m.detector.id))).toEqual([]);
    const cpf = up.data.colaboradores[3]!.cpf;
    const otherAdmin = await h.adminToken('other');
    const other = (await lookup({ detector: 'cpf', value: cpf }, otherAdmin, 'other')).json();
    const mine = (await lookup({ detector: 'cpf', value: cpf })).json();
    expect(other.fingerprint).not.toBe(mine.fingerprint);
    expect(other.total).toBe(0);
  });

  it('outlives the call_events retention', async () => {
    await h.services.dbHandle.pool.query('DELETE FROM call_events');
    const r = (await lookup({ detector: 'cpf', value: up.data.colaboradores[3]!.cpf })).json();
    expect(r.total).toBeGreaterThanOrEqual(1);
  });

  it('lists calls over the per-call cap as possible matches', async () => {
    await h.services.repos.tenants.update(seeded.tenantId, { settings: { observability: { subjectIndex: { maxPerCall: 1 } } } });
    await h.services.registry.invalidate(seeded.tenantId);
    const agent = await mcpClient(base, await h.token({ tenant: 'acme', sub: 'agent-bulk' }));
    try {
      await agent.callTool({ name: 'rh_colaboradores_list', arguments: { size: 20 } });
    } finally {
      await agent.close();
      await h.services.repos.tenants.update(seeded.tenantId, { settings: {} });
      await h.services.registry.invalidate(seeded.tenantId);
    }
    await h.services.callEvents.flush();
    const r = (await lookup({ detector: 'cpf', value: up.data.colaboradores[19]!.cpf })).json();
    expect(r.possibleMatches.some((m: { subject: string }) => m.subject === 'agent-bulk')).toBe(true);
  });

  it('only gateway-admin may ask; the lookup is audited without the value; invalid values are rejected', async () => {
    const owner = await h.token({ tenant: 'acme', sub: 'owner-l', roles: ['tool-owner'], groups: ['team-rh'] });
    const reader = await h.token({ tenant: 'acme', sub: 'reader-l', roles: ['analytics-reader'] });
    const cpf = up.data.colaboradores[3]!.cpf;
    expect((await lookup({ detector: 'cpf', value: cpf }, owner)).statusCode).toBe(403);
    expect((await lookup({ detector: 'cpf', value: cpf }, reader)).statusCode).toBe(403);
    expect((await lookup({ detector: 'cpf', value: '111.111.111-12' })).statusCode).toBe(400);
    const audits = await h.services.repos.audit.list(seeded.tenantId, { action: 'lgpd.subject_access', limit: 50 });
    expect(audits.length).toBeGreaterThan(0);
    const dump = JSON.stringify(audits);
    expect(dump).not.toContain(cpf.replace(/\D/g, ''));
    expect(dump).not.toContain(cpf);
    expect(audits[0]!.details).toMatchObject({ detector: expect.any(String), fingerprint: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(h.logs.join('\n')).not.toContain(cpf);
  });
});

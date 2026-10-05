import { findValueMatches } from '@mcp-gateway/redaction';
import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMaintenance } from '../src/maintenance';
import { startHarness, type Harness } from './harness';
import { mcpClient, seedRhTenant, type SeededTenant } from './seed';

describe('audit (F9.1)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let admin: string;

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    seeded = await seedRhTenant(h, up);
    admin = await h.adminToken('acme');
    const base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    // subject and client with PII (IdPs that use e-mail/CPF as sub must not leak into the audit)
    const client = await mcpClient(base, await h.token({ tenant: 'acme', sub: 'ana.souza@empresa.com', azp: 'bot-529.982.247-25' }));
    try {
      const colab = up.data.colaboradores[0]!;
      await client.callTool({ name: 'rh_colaborador_get', arguments: { id: colab.id } });
      await client.callTool({ name: 'rh_colaborador_get', arguments: { id: colab.cpf } }); // 404 with a CPF in the path
      await client.callTool({ name: 'rh_marcacao_create', arguments: { colaborador_id: colab.id, cpf: colab.cpf, data_hora: '2026-10-01T08:00:00-03:00', tipo: 'entrada' } });
      await client.callTool({ name: 'rh_colaboradores_list', arguments: { nome: colab.email } });
      await client.callTool({ name: 'does_not_exist', arguments: {} }).catch(() => undefined);
    } finally {
      await client.close();
    }
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
  });

  it('no event field holds clear-text PII (scan with the F5 detectors)', async () => {
    const rows = (await h.services.dbHandle.pool.query('SELECT * FROM audit_events')).rows;
    expect(rows.length).toBeGreaterThanOrEqual(5);
    const dump = JSON.stringify(rows);
    const leaks = findValueMatches(dump).filter((m) => ['cpf', 'cnpj', 'pis', 'email', 'telefone', 'cartao'].includes(m.detector.id));
    expect(leaks.map((l) => `${l.detector.id}:${l.text}`)).toEqual([]);
    for (const c of up.data.colaboradores.slice(0, 3)) {
      expect(dump).not.toContain(c.cpf);
      expect(dump).not.toContain(c.email);
    }
    const subjects = new Set(rows.filter((r) => r.action === 'tools/call').map((r) => r.subject));
    expect([...subjects]).toEqual(['a***@e***.com']);
  });

  it('GET /audit with filters (client, tool, period, decision)', async () => {
    const q = (qs: string) =>
      h.app.inject({ method: 'GET', url: `/admin/v1/audit?${qs}`, headers: { authorization: `Bearer ${admin}`, 'x-tenant': 'acme' } }).then((r) => r.json());
    const all = await q('action=tools/call');
    expect(all.total).toBeGreaterThanOrEqual(5);
    const byTool = await q(`toolId=${seeded.tools.rh_colaborador_get}`);
    expect(byTool.items.every((e: { toolName: string }) => e.toolName === 'rh_colaborador_get')).toBe(true);
    expect(byTool.total).toBe(2);
    const errors = await q('decision=error');
    expect(errors.items.length).toBeGreaterThanOrEqual(1);
    const future = await q(`from=${encodeURIComponent(new Date(Date.now() + 3600_000).toISOString())}`);
    expect(future.total).toBe(0);
    const agent = await h.token({ tenant: 'acme' });
    const denied = await h.app.inject({ method: 'GET', url: '/admin/v1/audit', headers: { authorization: `Bearer ${agent}` } });
    expect(denied.statusCode).toBe(403);
  });

  it('monthly partitioning and retention', async () => {
    const parts = async () =>
      (await h.services.dbHandle.pool.query("SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid JOIN pg_class p ON p.oid=i.inhparent WHERE p.relname='audit_events' ORDER BY 1")).rows.map((r) => r.relname as string);
    const now = new Date();
    const ym = (d: Date) => `audit_events_y${d.getUTCFullYear()}m${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(await parts()).toContain(ym(now));
    // events are written to the month's partition
    const cur = (await h.services.dbHandle.pool.query(`SELECT count(*)::int AS n FROM ${ym(now)}`)).rows[0].n;
    expect(cur).toBeGreaterThan(0);

    await h.services.dbHandle.pool.query("SELECT audit_ensure_partition((now() - interval '20 month')::date)");
    const old = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 20, 1));
    expect(await parts()).toContain(ym(old));
    const report = await runMaintenance(h.services);
    expect(report.auditDropped).toEqual([ym(old)]);
    expect(report.auditPartitions).toHaveLength(3);
    expect(await parts()).not.toContain(ym(old));
  });
});

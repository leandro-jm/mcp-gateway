import { findValueMatches } from '@mcp-gateway/redaction';
import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAgentAnalytics } from '../../src/analytics/job';
import { startHarness, type Harness } from '../harness';
import { mcpClient, seedRhTenant } from '../seed';

const TABLES = [
  'call_events',
  'call_rollups_hourly',
  'usage_rollups_daily',
  'agent_findings',
  'tool_transitions_daily',
  'composite_suggestions',
  'call_outcomes',
  // fingerprints are HMAC bytes: scan every other column
  'call_subject_refs',
];

/** F15.25: no table added by F15 holds clear-text PII, whatever the subject, client or arguments. */
describe('security: observability stores no clear-text PII', () => {
  let h: Harness;
  let up: FakeUpstream;

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    await seedRhTenant(h, up);
    const base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    const colab = up.data.colaboradores[0]!;
    // PII everywhere: subject, client name, agent name, arguments and responses
    for (let i = 0; i < 3; i++) {
      const token = await h.token({ tenant: 'acme', sub: `user${i}.${colab.email}`, azp: `bot-${colab.cpf}` });
      const c = await mcpClient(base, token, '/mcp/omni');
      try {
        await c.callTool({ name: 'search_tools', arguments: { query: `dados do cpf ${colab.cpf} e ${colab.email}` } });
        await c.callTool({ name: 'call_tool', arguments: { name: 'rh_colaborador_get', arguments: { id: colab.id } } });
        await c.callTool({ name: 'call_tool', arguments: { name: 'rh_colaboradores_list', arguments: { nome: colab.email } } });
        for (let j = 0; j < 3; j++) await c.callTool({ name: 'call_tool', arguments: { name: 'rh_colaborador_get', arguments: { id: colab.cpf } } });
        await c.callTool({ name: 'report_outcome', arguments: { outcome: 'partial', reason_code: 'wrong_data' } });
      } finally {
        await c.close();
      }
    }
    await h.services.callEvents.flush();
    await h.services.repos.rollups.rollup();
    await runAgentAnalytics(h.services);
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
  });

  it.each(TABLES)('%s', async (table) => {
    const cols = (await h.services.dbHandle.pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND data_type <> 'bytea'`, [table])).rows.map((r) => `"${r.column_name}"`);
    const rows = (await h.services.dbHandle.pool.query(`SELECT ${cols.join(', ')} FROM ${table}`)).rows;
    const dump = JSON.stringify(rows);
    const leaks = findValueMatches(dump).filter((m) => ['cpf', 'cnpj', 'pis', 'email', 'telefone', 'cartao'].includes(m.detector.id));
    expect(leaks.map((l) => `${l.detector.id}:${l.text}`)).toEqual([]);
    for (const c of up.data.colaboradores.slice(0, 3)) {
      expect(dump).not.toContain(c.cpf);
      expect(dump).not.toContain(c.cpf.replace(/\D/g, ''));
      expect(dump).not.toContain(c.email);
    }
    if (table === 'call_events') expect(rows.length).toBeGreaterThan(10);
  });
});

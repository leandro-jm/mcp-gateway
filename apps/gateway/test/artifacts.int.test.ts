import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMaintenance } from '../src/maintenance';
import { errorPayload } from '../src/proxy/result';
import { startHarness, startInfra, type Harness, type Infra } from './harness';
import { mcpClient, seedRhTenant, type SeededTenant } from './seed';

const text = (r: unknown) => ((r as { content: Array<{ type: string; text?: string }> }).content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');

describe('Code Mode: artifacts and SDK (F8)', () => {
  let infra: Infra;
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let base: string;
  let token: string;
  let client: Client;

  beforeAll(async () => {
    infra = await startInfra({ minio: true });
    h = await startHarness({ infra });
    up = await startFakeUpstream({ colaboradores: 18000 });
    seeded = await seedRhTenant(h, up);
    await h.services.repos.tenants.update(seeded.tenantId, { settings: { limits: { maxResponseBytes: 30 * 1024 * 1024 } } });
    await h.services.registry.invalidate(seeded.tenantId);
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    token = await h.token({ tenant: 'acme', sub: 'agente-code', azp: 'code-agent' });
    client = await mcpClient(base, token);
  }, 240_000);
  afterAll(async () => {
    await client?.close();
    await h?.teardown();
    await up?.close();
    await infra?.stop();
  });

  let bigUri: string;

  it('F8.2: a ~5 MB response becomes an artifact and returns < 2 KB of context with a useful preview', async () => {
    const r = await client.callTool({ name: 'rh_colaboradores_list', arguments: { size: 18000 } });
    expect(r.isError).toBeFalsy();
    const ctxText = text(r);
    expect(ctxText.length).toBeLessThan(2048);
    const summary = JSON.parse(ctxText);
    expect(summary.size_bytes).toBeGreaterThan(4_000_000);
    expect(summary.row_count).toBe(18000);
    expect(summary.records_path).toBe('$.items');
    expect(summary.schema_summary['$.items[]']).toMatchObject({ id: 'string', nome: 'string', cpf: 'string' });
    expect(summary.preview.length).toBeGreaterThanOrEqual(1);
    expect(summary.preview[0].cpf).toMatch(/^\*\*\*/); // artifact already redacted
    expect(summary.hint).toContain('Large response stored as an artifact.');
    const link = (r.content as Array<{ type: string; uri?: string }>).find((c) => c.type === 'resource_link');
    expect(link?.uri).toBe(summary.artifact_uri);
    expect((link as { description?: string }).description).toBe('Result of rh_colaboradores_list (18,000 records)');
    expect(r.structuredContent).toMatchObject({ artifact_uri: summary.artifact_uri });
    bigUri = summary.artifact_uri;
    const [ev] = await h.services.repos.audit.list(seeded.tenantId, { toolId: seeded.tools.rh_colaboradores_list, limit: 1 });
    expect(ev!.artifactId).toBe(bigUri.replace('artifact://', ''));
  });

  it('F8.2: the agent can force the artifact with _output', async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === 'rh_escalas_list')!;
    expect((tool.inputSchema.properties as any)._output).toMatchObject({ enum: ['inline', 'artifact'], description: expect.stringContaining('Optional:') });
    const r = await client.callTool({ name: 'rh_escalas_list', arguments: { _output: 'artifact' } });
    expect(JSON.parse(text(r)).artifact_uri).toMatch(/^artifact:\/\//);
  });

  it('F8.3: "how many employees per schedule" answered with artifact_query only', async () => {
    const q = await client.callTool({ name: 'artifact_query', arguments: { uri: bigUri, expression: 'items{escala_id: $count($)}' } });
    const counts = (q.structuredContent as { result: Record<string, number> }).result;
    const expected: Record<string, number> = {};
    for (const c of up.data.colaboradores) expected[c.escala_id] = (expected[c.escala_id] ?? 0) + 1;
    expect(counts).toEqual(expected);
    expect(text(q).length).toBeLessThan(300);

    const bad = await client.callTool({ name: 'artifact_query', arguments: { uri: bigUri, expression: 'items' } });
    expect(errorPayload(bad)).toMatchObject({ error: 'VALIDATION_ERROR', message: expect.stringContaining('result too large') });
  });

  it('ADR-013: a runaway artifact_query times out without freezing the gateway, and is audited', async () => {
    const started = Date.now();
    const slow = client.callTool({ name: 'artifact_query', arguments: { uri: bigUri, expression: '( $f := function($n){ $n>0 ? $f($n-1)+$f($n-1) : 0 }; $f(40) )' } });
    await new Promise((r) => setTimeout(r, 300));
    expect((await fetch(`${base}/healthz`)).status).toBe(200); // the event loop is free while the query runs
    expect(Date.now() - started).toBeLessThan(2000);
    expect(errorPayload(await slow)).toMatchObject({ error: 'VALIDATION_ERROR', message: expect.stringContaining('exceeded 5 s') });
    const huge = await client.callTool({ name: 'artifact_query', arguments: { uri: bigUri, expression: '$length($pad("", 500000000))' } });
    expect(errorPayload(huge)).toMatchObject({ error: 'VALIDATION_ERROR' });
    const audit = await h.services.repos.audit.list(seeded.tenantId, { toolName: 'artifact_query', decision: 'error' });
    expect(audit.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it('F8.3: artifact_read pages; resources/list and resources/read', async () => {
    const page = await client.callTool({ name: 'artifact_read', arguments: { uri: bigUri, offset: 100, limit: 5 } });
    const sc = page.structuredContent as { total: number; items: Array<{ id: string }> };
    expect(sc.total).toBe(18000);
    expect(sc.items.map((i) => i.id)).toEqual(up.data.colaboradores.slice(100, 105).map((c) => c.id));
    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri)).toContain(bigUri);
    expect(resources.resources.find((r) => r.uri === bigUri)!.description).toMatch(/^rh_colaboradores_list · 18,000 records · expires at /);
    const read = await client.readResource({ uri: bigUri });
    expect(JSON.parse((read.contents[0] as { text: string }).text).items).toHaveLength(18000);
  });

  it('F8.1: a replayed mcp-session-id does not reach another user\'s artifacts', async () => {
    const rpc = async (token: string, method: string, params: unknown) => {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'shared-session-1' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const body = await res.text();
      const json = body.startsWith('{') ? body : body.split('\n').find((l) => l.startsWith('data: '))!.slice(6);
      return JSON.parse(json).result;
    };
    const victim = await h.token({ tenant: 'acme', sub: 'victim-agent', azp: 'code-agent' });
    const attacker = await h.token({ tenant: 'acme', sub: 'attacker-agent', azp: 'code-agent' });
    const off = await rpc(victim, 'tools/call', { name: 'rh_escalas_list', arguments: { _output: 'artifact' } });
    const uri = off.structuredContent.artifact_uri as string;
    expect((await rpc(victim, 'resources/list', {})).resources.map((r: { uri: string }) => r.uri)).toContain(uri);
    expect((await rpc(attacker, 'resources/list', {})).resources).toEqual([]);
    expect(errorPayload(await rpc(attacker, 'tools/call', { name: 'artifact_read', arguments: { uri } }))).toMatchObject({ message: 'artifact not found or expired' });
  });

  it('F8.1: access only from the same tenant/session', async () => {
    const other = await mcpClient(base, await h.token({ tenant: 'acme', sub: 'outro-agente', azp: 'code-agent' }));
    try {
      const r = await other.callTool({ name: 'artifact_read', arguments: { uri: bigUri } });
      expect(errorPayload(r)).toMatchObject({ message: 'artifact not found or expired' });
      await expect(other.readResource({ uri: bigUri })).rejects.toThrow(/artifact not found or expired/);
    } finally {
      await other.close();
    }
    // same errors in the principal locale
    const pt = await mcpClient(base, await h.token({ tenant: 'acme', sub: 'outro-agente-pt', azp: 'code-agent', locale: 'pt-BR' }));
    try {
      expect(errorPayload(await pt.callTool({ name: 'artifact_read', arguments: { uri: bigUri } }))).toMatchObject({ message: 'artefato não encontrado ou expirado' });
      await expect(pt.readResource({ uri: bigUri })).rejects.toThrow(/artefato não encontrado ou expirado/);
      const tools = (await pt.listTools()).tools;
      expect(tools.find((t) => t.name === 'artifact_read')).toMatchObject({ title: 'Ler artefato' });
    } finally {
      await pt.close();
    }
  });

  it('F8.4: "list 500 punches → reprocess in batch" with ids by reference', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/admin/v1/tools/manual',
      headers: { authorization: `Bearer ${await h.adminToken('acme')}`, 'x-tenant': 'acme' },
      payload: {
        name: 'rh_marcacoes_reprocessar',
        description: 'Reprocessa marcações em lote',
        sourceId: seeded.sourceId,
        method: 'POST',
        path: '/lotes/marcacoes/reprocessar',
        body: { schema: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' }, maxItems: 1000 } } } },
        ownerTeam: 'team-rh',
      },
    });
    expect(created.statusCode).toBe(201);
    await h.services.repos.tools.setState(seeded.tenantId, created.json().id, 'disabled', 'enabled');
    await h.services.registry.invalidate(seeded.tenantId);

    const list = await client.callTool({ name: 'rh_marcacoes_list', arguments: { limit: 500, _output: 'artifact' } });
    const uri = JSON.parse(text(list)).artifact_uri;
    const r = await client.callTool({ name: 'rh_marcacoes_reprocessar', arguments: { ids: { $artifact: uri, path: '$.items[*].id' } } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent ?? JSON.parse(text(r))).toEqual({ recebidas: 500, processadas: 500 });
    expect((up.requests.at(-1)!.body as { ids: string[] }).ids).toHaveLength(500);
  });

  it('F8.1: the artifact expires and is cleaned up by the job', async () => {
    const r = await client.callTool({ name: 'rh_escalas_list', arguments: { _output: 'artifact' } });
    const uri = JSON.parse(text(r)).artifact_uri as string;
    const id = uri.replace('artifact://', '');
    const key = (await h.services.dbHandle.pool.query('SELECT object_key FROM artifacts WHERE id = $1', [id])).rows[0].object_key;
    await h.services.dbHandle.pool.query("UPDATE artifacts SET expires_at = now() - interval '1 minute' WHERE id = $1", [id]);
    expect(errorPayload(await client.callTool({ name: 'artifact_read', arguments: { uri } }))).toMatchObject({ message: 'artifact not found or expired' });
    const res = await runMaintenance(h.services);
    expect(res.artifacts).toBeGreaterThanOrEqual(1);
    expect((await h.services.dbHandle.pool.query('SELECT 1 FROM artifacts WHERE id = $1', [id])).rowCount).toBe(0);
    const store = (h.services.artifacts as unknown as { store: { getText(k: string): Promise<string> } }).store;
    await expect(store.getText(key)).rejects.toThrow();
  });

  it('F8.5: the generated SDK compiles (tsc --noEmit) and a script runs against the fake upstream', async () => {
    const auth = { authorization: `Bearer ${token}` };
    const res = await fetch(`${base}/sdk/acme.ts`, { headers: auth });
    expect(res.status).toBe(200);
    const sdk = (await res.text()).replace('http://gateway.test/mcp', `${base}/mcp`);
    expect(sdk).toContain('rhColaboradoresList(');
    expect(sdk).toContain('export type RhColaboradorGetInput');
    const dts = await (await fetch(`${base}/sdk/acme.d.ts`, { headers: auth })).text();
    expect(dts).toContain('export declare class GatewayClient');
    expect((await fetch(`${base}/sdk/outro.ts`, { headers: auth })).status).toBe(404);

    const dir = mkdtempSync(join(tmpdir(), 'mcp-sdk-'));
    writeFileSync(join(dir, 'gateway.ts'), sdk);
    writeFileSync(
      join(dir, 'exemplo.ts'),
      `import { GatewayClient } from './gateway';
const client = new GatewayClient({ token: process.env.TOKEN! });
const colab = await client.rhColaboradorGet({ id: '${up.data.colaboradores[0]!.id}' });
const escalas = await client.rhEscalasList({ colaborador: colab.id });
console.log(JSON.stringify({ nome: colab.nome, escalas: escalas.items?.length }));
`,
    );
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', types: ['node'], skipLibCheck: true, allowImportingTsExtensions: false } , include: ['*.ts'] }),
    );
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    // tsc with the monorepo Node types
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: 'ES2023', module: 'Preserve', moduleResolution: 'bundler', typeRoots: [join(root, 'node_modules/@types')], types: ['node'], skipLibCheck: true },
        include: ['*.ts'],
      }),
    );
    const tsc = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', dir], { encoding: 'utf8' });
    expect(tsc.stdout + tsc.stderr).toBe('');
    expect(tsc.status).toBe(0);

    // async: the gateway runs in this same process and needs a free event loop
    const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', join(dir, 'exemplo.ts')], { env: { ...process.env, TOKEN: token }, cwd: root });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout.trim())).toEqual({ nome: up.data.colaboradores[0]!.nome, escalas: 1 });
  });
});

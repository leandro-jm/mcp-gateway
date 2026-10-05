import { rhOpenApiSpec } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCrawl } from '../src/crawl';
import { startCrawlerHarness, type CrawlerHarness } from './helpers';

type Spec = ReturnType<typeof rhOpenApiSpec> & { paths: Record<string, any>; components: any };

/** CA F2.4: new, compatible change, breaking and removed (+ reapplied overrides). */
describe('tool registration by the crawler', () => {
  let h: CrawlerHarness;
  let tenantId: string;
  let sourceId: string;

  beforeAll(async () => {
    h = await startCrawlerHarness();
    tenantId = (await h.services.repos.tenants.create({ slug: 'acme', name: 'ACME' })).id;
    sourceId = (
      await h.services.repos.sources.create(tenantId, {
        name: 'rh',
        openapiInline: rhOpenApiSpec('http://up.local'),
        baseUrl: 'http://up.local',
        ownerTeam: 'team-rh',
      })
    ).id;
  });
  afterAll(async () => h?.teardown());

  const crawl = async (spec?: Spec) => {
    if (spec) await h.services.repos.sources.update(tenantId, sourceId, { openapiInline: spec });
    const run = await runCrawl(h.services, { tenantId, sourceId, trigger: 'manual' });
    expect(run.status, run.error ?? '').toBe('succeeded');
    return run;
  };
  const tool = async (name: string) => (await h.services.repos.tools.findByName(tenantId, name))!;
  const drift = async (toolId: string) => h.services.repos.drift.list(tenantId, { toolId });

  it('scenario 1 — new tools start disabled, version 1, with drift added', async () => {
    const run = await crawl();
    expect(run.stats).toMatchObject({ specVersion: '3.1', operations: 6, generated: 6, created: 6, removed: 0 });
    const all = await h.services.repos.tools.listBySource(tenantId, sourceId);
    expect(all).toHaveLength(6);
    expect(all.every((t) => t.state === 'disabled' && t.version === 1 && t.specHash && t.ownerTeam === 'team-rh')).toBe(true);
    expect((await drift(all[0]!.id)).map((d) => d.kind)).toEqual(['added']);
    // F6.2: list tools get a suggested (inactive) projection
    expect(run.stats).toMatchObject({ projectionsSuggested: 3 });
    const list = await tool('rh_colaboradores_list');
    const sug = await h.services.repos.projections.get(tenantId, list.id);
    expect(sug).toMatchObject({ status: 'suggested', include: expect.arrayContaining(['$.items[*].id', '$.items[*].nome', '$.total']) });
    // re-crawl without changes creates nothing
    expect((await crawl()).stats).toMatchObject({ created: 0, updated: 0, unchanged: 6 });
  });

  it('scenario 2 — compatible change creates a new version and keeps the state (and the override)', async () => {
    const t = await tool('rh_colaboradores_list');
    await h.services.repos.tools.setState(tenantId, t.id, 'disabled', 'enabled');
    await h.services.repos.tools.setOverrides(tenantId, t.id, { name: 'buscar_colaboradores', description: 'Busca colaboradores (owner)' });

    const spec = rhOpenApiSpec('http://up.local') as Spec;
    spec.paths['/colaboradores'].get.parameters.push({ name: 'cargo', in: 'query', schema: { type: 'string' } });
    spec.paths['/colaboradores'].get.summary = 'Lista colaboradores ativos';
    const run = await crawl(spec);
    expect(run.stats).toMatchObject({ updated: 1, breaking: 0 });

    const after = await tool('buscar_colaboradores');
    expect(after.id).toBe(t.id);
    expect(after.state).toBe('enabled');
    expect(after.version).toBe(2);
    expect(after.overrides).toMatchObject({ name: 'buscar_colaboradores', description: 'Busca colaboradores (owner)' });
    expect(Object.keys(after.inputSchema.properties as object)).toContain('cargo');
    const versions = await h.services.repos.tools.versions(tenantId, t.id);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect((versions[0]!.diff as any).changes.map((c: any) => c.kind)).toEqual(
      expect.arrayContaining(['field_added', 'description_changed']),
    );
    expect((await drift(t.id))[0]).toMatchObject({ kind: 'changed' });
  });

  it('scenario 3 — breaking change disables the tool and records breaking drift', async () => {
    const t = await tool('rh_marcacao_create');
    await h.services.repos.tools.setState(tenantId, t.id, 'disabled', 'enabled');
    const spec = rhOpenApiSpec('http://up.local') as Spec;
    spec.paths['/colaboradores'].get.parameters.push({ name: 'cargo', in: 'query', schema: { type: 'string' } });
    spec.paths['/colaboradores'].get.summary = 'Lista colaboradores ativos';
    spec.components.schemas.NovaMarcacao.required.push('origem');
    const run = await crawl(spec);
    expect(run.stats).toMatchObject({ updated: 1, breaking: 1 });
    const after = await tool('rh_marcacao_create');
    expect(after.state).toBe('disabled');
    expect(after.version).toBe(2);
    const [d] = await drift(t.id);
    expect(d!.kind).toBe('breaking');
    expect((d!.diff as any).changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'required_added', path: 'input.origem', breaking: true })]),
    );
  });

  it('scenario 4 — removed operation becomes removed; if it comes back, it returns disabled', async () => {
    const spec = rhOpenApiSpec('http://up.local') as Spec;
    spec.paths['/colaboradores'].get.parameters.push({ name: 'cargo', in: 'query', schema: { type: 'string' } });
    spec.paths['/colaboradores'].get.summary = 'Lista colaboradores ativos';
    spec.components.schemas.NovaMarcacao.required.push('origem');
    delete spec.paths['/marcacoes/{id}'];
    const run = await crawl(spec);
    expect(run.stats).toMatchObject({ removed: 1, generated: 5 });
    const removed = await tool('rh_marcacao_delete');
    expect(removed.state).toBe('removed');
    expect((await drift(removed.id))[0]!.kind).toBe('removed');
    // re-crawl does not record a new removal drift
    expect((await crawl(spec)).stats).toMatchObject({ removed: 0, driftEvents: 0 });

    const back = rhOpenApiSpec('http://up.local') as Spec;
    back.paths['/colaboradores'].get.parameters.push({ name: 'cargo', in: 'query', schema: { type: 'string' } });
    back.paths['/colaboradores'].get.summary = 'Lista colaboradores ativos';
    back.components.schemas.NovaMarcacao.required.push('origem');
    expect((await crawl(back)).stats).toMatchObject({ restored: 1 });
    expect((await tool('rh_marcacao_delete')).state).toBe('disabled');
  });

  it('operation marked deprecated in the spec deprecates the tool', async () => {
    const spec = rhOpenApiSpec('http://up.local') as Spec;
    spec.paths['/colaboradores'].get.parameters.push({ name: 'cargo', in: 'query', schema: { type: 'string' } });
    spec.paths['/colaboradores'].get.summary = 'Lista colaboradores ativos';
    spec.components.schemas.NovaMarcacao.required.push('origem');
    spec.paths['/escalas'].get.deprecated = true;
    expect((await crawl(spec)).stats).toMatchObject({ deprecated: 1 });
    expect((await tool('rh_escalas_list')).state).toBe('deprecated');
  });

  it('spec operation equivalent to a manual tool warns and does not replace it', async () => {
    const manual = await h.services.repos.tools.create(tenantId, {
      kind: 'manual',
      sourceId,
      name: 'rh_escalas_manual',
      description: 'manual',
      operationRef: { method: 'GET', path: '/escalas', mapping: { params: [] } },
      inputSchema: { type: 'object' },
    });
    const spec = rhOpenApiSpec('http://up.local') as Spec;
    spec.paths['/colaboradores'].get.parameters.push({ name: 'cargo', in: 'query', schema: { type: 'string' } });
    spec.paths['/colaboradores'].get.summary = 'Lista colaboradores ativos';
    spec.components.schemas.NovaMarcacao.required.push('origem');
    const run = await crawl(spec);
    expect((run.stats as any).warnings).toEqual([expect.stringContaining('spec operation GET /escalas matches manual tool rh_escalas_manual')]);
    const after = await h.services.repos.tools.get(tenantId, manual.id);
    expect(after).toMatchObject({ kind: 'manual', description: 'manual', version: 1 });
  });

  it('legacy rows (NULL spec_hash, migration 0013) are refreshed without a new version or drift', async () => {
    const t = await tool('rh_colaborador_get');
    await h.services.repos.tools.update(tenantId, t.id, { specHash: null });
    const driftBefore = (await drift(t.id)).length;
    const run = await crawl();
    expect(run.stats).toMatchObject({ created: 0, updated: 0, breaking: 0 });
    const after = await tool('rh_colaborador_get');
    expect(after.version).toBe(t.version);
    expect(after.specHash).toBe(t.specHash);
    expect(await drift(t.id)).toHaveLength(driftBefore);
  });

  it('a parse failure records the run as failed with a translatable error', async () => {
    await h.services.repos.sources.update(tenantId, sourceId, { openapiInline: { openapi: '9.9.9' } });
    const run = await runCrawl(h.services, { tenantId, sourceId, trigger: 'manual' });
    expect(run.status).toBe('failed');
    expect(run.error).toBe('unsupported spec version (expected swagger 2.0 or openapi 3.0/3.1)');
    expect(run.errorKey).toBe('toolgen.unsupportedSpecVersion');
    expect(run.errorParams).toBeNull();
    expect(run.finishedAt).not.toBeNull();
  });
});

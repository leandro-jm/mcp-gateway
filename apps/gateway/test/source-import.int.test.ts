import { FAKE_CREDENTIALS, rhPostmanCollection, startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness';

/** Admin API of the source import (F13.6, ADR-014). The crawl itself is covered in apps/crawler. */
describe('source import (Admin API)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let admin: string;

  const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
    h.app.inject({
      method: method as 'GET',
      url: `/admin/v1${url}`,
      headers: { authorization: `Bearer ${admin}`, 'x-tenant': 'acme', ...headers },
      ...(body ? { payload: body as object } : {}),
    });

  const curl = (base: string) => `
curl '${base}/colaboradores?size=20' -H 'Authorization: Bearer secret-token-123'
curl ${base}/colaboradores/col-00001 -H 'Authorization: Bearer secret-token-123'
curl -X POST ${base}/marcacoes -H 'Content-Type: application/json' --data-raw '{"colaborador_id":"col-00002","data_hora":"2026-10-01T08:00:00-03:00","tipo":"entrada"}'
`;

  beforeAll(async () => {
    h = await startHarness();
    up = await startFakeUpstream();
    admin = await h.adminToken('acme');
    await h.services.repos.tenants.create({ slug: 'acme', name: 'ACME' });
  });
  afterAll(async () => {
    await h?.teardown();
    await up?.close();
  });

  it('preview converts cURL without saving anything', async () => {
    const r = await call('POST', '/sources/import/preview', { input: { kind: 'text', text: curl(up.url) } });
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json();
    expect(p).toMatchObject({ format: 'curl', specVersion: '3.1', suggestedName: 'api', baseUrlCandidates: [up.url], suggestedCredential: { type: 'bearer_static' } });
    expect(p.operations.map((o: { key: string; status: string; toolName: string }) => [o.key, o.status, o.toolName])).toEqual([
      ['GET /colaboradores', 'new', 'api_colaboradores_list'],
      ['GET /colaboradores/{colaborador_id}', 'new', 'api_colaboradores_get'],
      ['POST /marcacoes', 'new', 'api_marcacoes_create'],
    ]);
    expect(p.tools.find((t: { name: string }) => t.name === 'api_colaboradores_get').inputSchema.required).toEqual(['colaborador_id']);
    expect(p.warnings).toEqual([{ key: 'import.authStripped', message: 'credential removed from header "Authorization": register it as a source credential' }]);
    expect(r.body).not.toContain('secret-token-123');
    expect((await call('GET', '/sources')).json().total).toBe(0);
  });

  it('preview honors sourceName, include and the user locale', async () => {
    const adminPt = await h.token({ roles: ['gateway-admin'], tenant: 'acme', sub: 'admin-pt', locale: 'pt-BR' });
    const r = await call(
      'POST',
      '/sources/import/preview',
      { input: { kind: 'text', text: curl(up.url) }, sourceName: 'rh', include: ['POST /marcacoes'] },
      { authorization: `Bearer ${adminPt}` },
    );
    expect(r.json().tools.map((t: { name: string }) => t.name)).toEqual(['rh_marcacoes_create']);
    expect(r.json().warnings[0].message).toBe('credencial removida de header "Authorization": cadastre-a como credencial da source');
  });

  it('invalid input is a translated 400', async () => {
    const r = await call('POST', '/sources/import/preview', { input: { kind: 'text', text: '{"hello": 1}' } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'VALIDATION_ERROR', message: expect.stringMatching(/^unrecognized format/) });
    const v1 = await call('POST', '/sources/import/preview', { input: { kind: 'text', text: JSON.stringify({ id: 'x', order: [], requests: [] }) } });
    expect(v1.json().message).toMatch(/Postman collection v1/);
  });

  it('imports cURL into a new inline source, rebased on the base URL, and enqueues the crawl', async () => {
    const r = await call('POST', '/sources/import', {
      input: { kind: 'text', text: curl(up.url) },
      include: ['GET /colaboradores', 'GET /colaboradores/{colaborador_id}'],
      target: { kind: 'new', name: 'rh_curl', baseUrl: up.url, ownerTeam: 'team-rh' },
    });
    expect(r.statusCode, r.body).toBe(201);
    const body = r.json();
    expect(body.source).toMatchObject({ name: 'rh_curl', hasInlineSpec: true, openapiUrl: null, specFormat: 'openapi', importMeta: { format: 'curl', input: 'text', operations: 2 } });
    expect(body.crawlRun.status).toBe('queued');
    expect(body.added).toEqual(['GET /colaboradores', 'GET /colaboradores/{colaborador_id}']);

    const spec = (await call('GET', `/sources/${body.source.id}/openapi`)).json();
    expect(Object.keys(spec.paths)).toEqual(['/colaboradores', '/colaboradores/{colaborador_id}']);
    expect(JSON.stringify(spec)).not.toContain('secret-token-123');
  });

  it('merges into an existing inline source (add keeps, replace overwrites)', async () => {
    const source = (await call('GET', '/sources')).json().items.find((s: { name: string }) => s.name === 'rh_curl');
    const preview = (await call('POST', '/sources/import/preview', { input: { kind: 'text', text: curl(up.url) }, targetSourceId: source.id })).json();
    expect(preview.operations.map((o: { key: string; status: string }) => `${o.status} ${o.key}`)).toEqual([
      'unchanged GET /colaboradores',
      'unchanged GET /colaboradores/{colaborador_id}',
      'new POST /marcacoes',
    ]);
    expect(preview.tools.map((t: { name: string }) => t.name)).toContain('rh_curl_marcacoes_create');

    const changed = curl(up.url).replace('size=20', 'size=20&ativo=true');
    const add = (await call('POST', '/sources/import', { input: { kind: 'text', text: changed }, target: { kind: 'existing', sourceId: source.id, mode: 'add' } })).json();
    expect(add).toMatchObject({ added: ['POST /marcacoes'], replaced: [], conflicts: ['GET /colaboradores', 'GET /colaboradores/{colaborador_id}'] });
    expect(add.source.importMeta).toMatchObject({ merges: 1, operations: 3 });
    expect(add.warnings.map((w: { key: string }) => w.key)).toContain('import.mergeConflict');

    const replace = (
      await call('POST', '/sources/import', { input: { kind: 'text', text: changed }, include: ['GET /colaboradores'], target: { kind: 'existing', sourceId: source.id, mode: 'replace' } })
    ).json();
    expect(replace).toMatchObject({ added: [], replaced: ['GET /colaboradores'], conflicts: [] });
    const spec = (await call('GET', `/sources/${source.id}/openapi`)).json();
    expect(spec.paths['/colaboradores'].get.parameters.map((p: { name: string }) => p.name)).toEqual(['size', 'ativo']);
  });

  it('a URL-backed source cannot receive imports', async () => {
    const urlSource = (await call('POST', '/sources', { name: 'rh_url', openapiUrl: `${up.url}/openapi.json`, baseUrl: up.url })).json();
    const r = await call('POST', '/sources/import', { input: { kind: 'text', text: curl(up.url) }, target: { kind: 'existing', sourceId: urlSource.id } });
    expect(r.statusCode).toBe(400);
    expect(r.json().message).toMatch(/^the source has no inline spec/);
    expect((await call('GET', `/sources/${urlSource.id}/openapi`)).statusCode).toBe(400);
  });

  it('Postman collection URL: preview downloads it with the credential; import keeps the URL', async () => {
    const protectedUp = await startFakeUpstream({ protectSpec: true });
    try {
      const url = `${protectedUp.url}/postman/collection.json`;
      expect((await call('POST', '/sources/import/preview', { input: { kind: 'url', url } })).json().message).toMatch(/HTTP 401|401/);
      const cred = (
        await call('POST', '/credentials', { name: 'rh-key', type: 'api_key', config: { in: 'header', name: 'x-api-key', value: FAKE_CREDENTIALS.apiKey } })
      ).json();
      const preview = await call('POST', '/sources/import/preview', { input: { kind: 'url', url, credentialId: cred.id } });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json()).toMatchObject({ format: 'postman', suggestedName: 'rh_fake_postman', suggestedCredential: { type: 'api_key', in: 'header', name: 'x-api-key' } });
      expect(preview.json().operations).toHaveLength(5);

      const created = await call('POST', '/sources/import', { input: { kind: 'url', url, credentialId: cred.id }, target: { kind: 'new', name: 'rh_pm', baseUrl: protectedUp.url } });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json().source).toMatchObject({ openapiUrl: url, specFormat: 'postman', hasInlineSpec: false, credentialId: cred.id, importMeta: { format: 'postman', input: 'url' } });
    } finally {
      await protectedUp.close();
    }
  });

  it('HAR and Postman text are stored converted', async () => {
    const collection = rhPostmanCollection(up.url, up.data);
    const pm = await call('POST', '/sources/import', { input: { kind: 'text', text: JSON.stringify(collection) }, target: { kind: 'new', name: 'rh_pm_text', baseUrl: up.url } });
    expect(pm.statusCode, pm.body).toBe(201);
    expect(pm.json().source).toMatchObject({ hasInlineSpec: true, specFormat: 'openapi', importMeta: { format: 'postman', operations: 5 } });

    const har = {
      log: {
        entries: [
          {
            _resourceType: 'fetch',
            request: { method: 'GET', url: `${up.url}/escalas`, headers: [{ name: 'Cookie', value: 'session=abc' }] },
            response: { status: 200, content: { mimeType: 'application/json', text: '[{"id":"esc-5x2","nome":"5x2"}]' } },
          },
        ],
      },
    };
    const h2 = await call('POST', '/sources/import', { input: { kind: 'text', text: JSON.stringify(har) }, target: { kind: 'new', name: 'rh_har', baseUrl: up.url } });
    expect(h2.statusCode, h2.body).toBe(201);
    expect(h2.json()).toMatchObject({ added: ['GET /escalas'], warnings: [{ key: 'import.authStripped' }] });
  });

  it('owners cannot import; the OpenAPI document is readable by owners', async () => {
    const owner = await h.token({ roles: ['tool-owner'], tenant: 'acme', groups: ['team-rh'] });
    const r = await h.app.inject({
      method: 'POST',
      url: '/admin/v1/sources/import/preview',
      headers: { authorization: `Bearer ${owner}`, 'x-tenant': 'acme' },
      payload: { input: { kind: 'text', text: curl(up.url) } },
    });
    expect(r.statusCode).toBe(403);
  });

  it('the import routes accept bodies above the global 5 MB limit', async () => {
    const big = `${curl(up.url)}\n# ${'x'.repeat(6 * 1024 * 1024)}`;
    const r = await call('POST', '/sources/import/preview', { input: { kind: 'text', text: big } });
    expect(r.statusCode, r.body.slice(0, 200)).toBe(200);
  });
});

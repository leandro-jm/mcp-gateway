import { generateDataKey } from '@mcp-gateway/core';
import { FAKE_CREDENTIALS, startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, startInfra, type Harness, type Infra } from '../../gateway/test/harness';
import { mcpClient } from '../../gateway/test/seed';
import { startWorkers, type CrawlerWorkers } from '../src/worker';
import { startCrawlerHarness, waitFor, type CrawlerHarness } from './helpers';

/** CA F13.6: a pasted cURL becomes a source, is crawled and its tools work through /mcp. */
describe('cURL import end to end', () => {
  let infra: Infra;
  let gw: Harness;
  let crawler: CrawlerHarness;
  let workers: CrawlerWorkers;
  let up: FakeUpstream;
  let admin: string;

  beforeAll(async () => {
    infra = await startInfra();
    const masterKey = generateDataKey().toString('base64');
    gw = await startHarness({ infra, env: { GATEWAY_MASTER_KEY: masterKey } });
    crawler = await startCrawlerHarness({ pg: infra.pg, redis: infra.redis, masterKey });
    workers = startWorkers(crawler.services);
    up = await startFakeUpstream();
    admin = await gw.adminToken('acme');
  });
  afterAll(async () => {
    await workers?.close();
    await crawler?.teardown();
    await gw?.teardown();
    await up?.close();
    await infra?.stop();
  });

  const call = (method: string, url: string, body?: unknown) =>
    gw.app.inject({
      method: method as 'GET',
      url: `/admin/v1${url}`,
      headers: { authorization: `Bearer ${admin}`, 'x-tenant': 'acme' },
      ...(body ? { payload: body as object } : {}),
    });

  it('imports, crawls and calls the generated tools', async () => {
    await call('POST', '/tenants', { slug: 'acme', name: 'ACME' });
    const cred = (
      await call('POST', '/credentials', { name: 'rh-key', type: 'api_key', config: { in: 'header', name: 'x-api-key', value: FAKE_CREDENTIALS.apiKey } })
    ).json();
    // as copied from the API docs: the docs' key is stripped, the source credential is used instead
    const text = `
curl '${up.url}/colaboradores?size=20&unidade_id=uni-1' -H 'X-API-Key: key-from-the-docs'
curl ${up.url}/colaboradores/col-00001 -H 'X-API-Key: key-from-the-docs'
curl -X POST ${up.url}/marcacoes -H 'X-API-Key: key-from-the-docs' -H 'Content-Type: application/json' \\
  -d '{"colaborador_id":"col-00002","data_hora":"2026-10-01T08:00:00-03:00","tipo":"entrada"}'
`;
    const imported = await call('POST', '/sources/import', { input: { kind: 'text', text }, target: { kind: 'new', name: 'rh', baseUrl: up.url, credentialId: cred.id } });
    expect(imported.statusCode, imported.body).toBe(201);

    const runId = imported.json().crawlRun.id;
    const run = await waitFor(async () => {
      const r = (await call('GET', `/crawl-runs/${runId}`)).json();
      return r.status === 'succeeded' || r.status === 'failed' ? r : undefined;
    }, 20_000);
    expect(run.status, run.error).toBe('succeeded');
    expect(run.stats).toMatchObject({ specFormat: 'openapi', operations: 3, created: 3 });

    // default deny: tools start disabled; enabling + a policy makes them callable
    const tools = (await call('GET', `/tools?sourceId=${imported.json().source.id}`)).json().items as Array<{ id: string; name: string; state: string }>;
    expect(tools.map((t) => t.name).sort()).toEqual(['rh_colaboradores_get', 'rh_colaboradores_list', 'rh_marcacoes_create']);
    expect(tools.every((t) => t.state === 'disabled')).toBe(true);
    for (const t of tools) expect((await call('POST', `/tools/${t.id}/enable`)).statusCode).toBe(200);
    const tenant = (await gw.services.repos.tenants.findBySlug('acme'))!;
    await gw.services.repos.policies.create(tenant.id, { subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*' });
    await gw.services.registry.invalidate(tenant.id);

    const client = await mcpClient(await gw.app.listen({ port: 0, host: '127.0.0.1' }), await gw.token({ tenant: 'acme' }));
    try {
      const colab = up.data.colaboradores[4]!;
      const got = await client.callTool({ name: 'rh_colaboradores_get', arguments: { colaborador_id: colab.id } });
      expect(got.isError, JSON.stringify(got.content)).toBeFalsy();
      // cURL carries no response sample: no output schema, so the result is JSON text content
      expect(got.structuredContent).toBeUndefined();
      expect(JSON.parse((got.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ id: colab.id });
      const last = up.requests.at(-1)!;
      expect(last.url).toBe(`/colaboradores/${colab.id}`);
      expect(last.headers['x-api-key']).toBe(FAKE_CREDENTIALS.apiKey);

      const list = await client.callTool({ name: 'rh_colaboradores_list', arguments: { size: 2 } });
      expect(list.isError, JSON.stringify(list.content)).toBeFalsy();

      const created = await client.callTool({
        name: 'rh_marcacoes_create',
        arguments: { colaborador_id: colab.id, data_hora: '2026-10-03T08:00:00-03:00', tipo: 'entrada' },
      });
      expect(created.isError, JSON.stringify(created.content)).toBeFalsy();
      expect(up.data.marcacoes.at(-1)).toMatchObject({ colaborador_id: colab.id, tipo: 'entrada' });
    } finally {
      await client.close();
    }
  });
});

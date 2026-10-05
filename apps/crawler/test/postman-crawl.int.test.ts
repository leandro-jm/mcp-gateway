import { generateDataKey } from '@mcp-gateway/core';
import { FAKE_CREDENTIALS, startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, startInfra, type Harness, type Infra } from '../../gateway/test/harness';
import { startWorkers, type CrawlerWorkers } from '../src/worker';
import { startCrawlerHarness, waitFor, type CrawlerHarness } from './helpers';

/** CA F13.5: a source backed by a Postman collection URL is converted to OpenAPI on every crawl. */
describe('crawl of a Postman collection URL', () => {
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
    up = await startFakeUpstream({ protectSpec: true });
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

  async function crawl(sourceId: string) {
    const runId = (await call('POST', `/sources/${sourceId}/crawl`)).json().id;
    return waitFor(async () => {
      const r = (await call('GET', `/crawl-runs/${runId}`)).json();
      return r.status === 'succeeded' || r.status === 'failed' ? r : undefined;
    }, 20_000);
  }

  it('downloads the collection with the source credential and registers disabled tools', async () => {
    await call('POST', '/tenants', { slug: 'acme', name: 'ACME' });
    const cred = (
      await call('POST', '/credentials', { name: 'rh-key', type: 'api_key', config: { in: 'header', name: 'x-api-key', value: FAKE_CREDENTIALS.apiKey } })
    ).json();
    const created = await call('POST', '/sources', {
      name: 'rh_postman',
      openapiUrl: `${up.url}/postman/collection.json`,
      specFormat: 'postman',
      baseUrl: up.url,
      credentialId: cred.id,
    });
    expect(created.statusCode, created.body).toBe(201);
    const source = created.json();
    expect(source.specFormat).toBe('postman');

    const run = await crawl(source.id);
    expect(run.status, run.error).toBe('succeeded');
    expect(run.stats).toMatchObject({ specFormat: 'postman', specVersion: '3.1', operations: 5, created: 5 });

    const tools = (await call('GET', `/tools?sourceId=${source.id}`)).json();
    expect(tools.items.map((t: { name: string }) => t.name).sort()).toEqual([
      'rh_postman_colaboradores_get',
      'rh_postman_colaboradores_list',
      'rh_postman_escalas_list',
      'rh_postman_marcacoes_create',
      'rh_postman_marcacoes_delete',
    ]);
    expect(tools.items.every((t: { state: string }) => t.state === 'disabled')).toBe(true);

    // a second crawl reconverts the collection: same operations, nothing changes
    const again = await crawl(source.id);
    expect(again.status, again.error).toBe('succeeded');
    expect(again.stats).toMatchObject({ created: 0, updated: 0 });
  });

  it('a collection URL without specFormat fails as an invalid OpenAPI spec', async () => {
    const source = (await call('POST', '/sources', { name: 'rh_wrong', openapiUrl: `${up.url}/postman/collection.json`, baseUrl: up.url })).json();
    const run = await crawl(source.id);
    expect(run.status).toBe('failed');
  });
});

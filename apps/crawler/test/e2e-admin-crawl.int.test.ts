import { generateDataKey } from '@mcp-gateway/core';
import { FAKE_CREDENTIALS, startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, startInfra, type Harness, type Infra } from '../../gateway/test/harness';
import { startWorkers, type CrawlerWorkers } from '../src/worker';
import { startCrawlerHarness, waitFor, type CrawlerHarness } from './helpers';

/** CA F2.1: a manual crawl through the Admin API is run by the worker and recorded in crawl_runs. */
describe('manual crawl end to end', () => {
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

  it('enqueues, runs with an OAuth2 credential and records the run', async () => {
    await call('POST', '/tenants', { slug: 'acme', name: 'ACME' });
    const cred = (
      await call('POST', '/credentials', {
        name: 'rh-oauth',
        type: 'oauth2_client_credentials',
        config: { tokenUrl: `${up.url}/oauth/token`, clientId: FAKE_CREDENTIALS.clientId, clientSecret: FAKE_CREDENTIALS.clientSecret },
      })
    ).json();
    const source = (
      await call('POST', '/sources', { name: 'rh', openapiUrl: `${up.url}/openapi.json`, baseUrl: up.url, credentialId: cred.id, ownerTeam: 'team-rh' })
    ).json();

    const queued = await call('POST', `/sources/${source.id}/crawl`);
    expect(queued.statusCode).toBe(202);
    const runId = queued.json().id;

    const run = await waitFor(async () => {
      const r = (await call('GET', `/crawl-runs/${runId}`)).json();
      return r.status === 'succeeded' || r.status === 'failed' ? r : undefined;
    }, 20_000);
    expect(run.status, run.error).toBe('succeeded');
    expect(run.stats).toMatchObject({ operations: 6, created: 6 });
    expect(run.startedAt).not.toBeNull();
    expect(up.tokenRequests()).toBeGreaterThanOrEqual(1);

    const tools = (await call('GET', `/tools?sourceId=${source.id}`)).json();
    expect(tools.total).toBe(6);
    expect(tools.items.every((t: { state: string }) => t.state === 'disabled')).toBe(true);
    expect((await call('GET', `/sources/${source.id}`)).json().lastCrawlAt).not.toBeNull();

    // the data plane registry was invalidated and already sees the tools
    const snap = await gw.services.registry.getBySlug('acme');
    expect(snap.tools).toHaveLength(6);
  });
});

import { createHmac } from 'node:crypto';
import { rhOpenApiSpec } from '@mcp-gateway/testkit';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCrawl } from '../src/crawl';
import { syncSchedules } from '../src/scheduler';
import { enqueueDriftWebhooks } from '../src/webhooks';
import { startWorkers, type CrawlerWorkers } from '../src/worker';
import { startCrawlerHarness, waitFor, type CrawlerHarness } from './helpers';

describe('drift webhooks and scheduling (F2.5 / F2.1)', () => {
  let h: CrawlerHarness;
  let workers: CrawlerWorkers;
  const received: Array<{ headers: Record<string, unknown>; body: any; raw: string }> = [];
  const receiver = Fastify();
  let receiverUrl: string;
  let tenantId: string;
  let sourceId: string;

  beforeAll(async () => {
    receiver.addContentTypeParser('application/json', { parseAs: 'string' }, (_r, body, done) => done(null, body));
    receiver.post('/hook', async (req) => {
      received.push({ headers: req.headers, body: JSON.parse(req.body as string), raw: req.body as string });
      return { ok: true };
    });
    receiverUrl = `${await receiver.listen({ port: 0, host: '127.0.0.1' })}/hook`;
    h = await startCrawlerHarness();
    workers = startWorkers(h.services);
    tenantId = (
      await h.services.repos.tenants.create({
        slug: 'acme',
        name: 'ACME',
        settings: {
          webhooks: [
            { id: 'rh', url: receiverUrl, ownerTeam: 'team-rh', events: ['breaking'], secret: 's3cr3t' },
            { id: 'ops', url: receiverUrl, ownerTeam: 'team-ops' },
          ],
        },
      })
    ).id;
    sourceId = (
      await h.services.repos.sources.create(tenantId, {
        name: 'rh',
        openapiInline: rhOpenApiSpec('http://up.local'),
        baseUrl: 'http://up.local',
        ownerTeam: 'team-rh',
      })
    ).id;
  });
  afterAll(async () => {
    await workers?.close();
    await h?.teardown();
    await receiver.close();
  });

  it('a breaking event fires the webhook exactly once, signed', async () => {
    await runCrawl(h.services, { tenantId, sourceId, trigger: 'manual' });
    const spec = rhOpenApiSpec('http://up.local') as any;
    spec.components.schemas.NovaMarcacao.required.push('origem');
    await h.services.repos.sources.update(tenantId, sourceId, { openapiInline: spec });
    const run = await runCrawl(h.services, { tenantId, sourceId, trigger: 'manual' });
    expect(run.stats).toMatchObject({ breaking: 1, webhooksEnqueued: 1 });

    await waitFor(async () => received.length === 1);
    const [msg] = received;
    expect(msg!.body).toMatchObject({ type: 'tool.drift', kind: 'breaking', tool: { name: 'rh_marcacao_create', state: 'disabled' } });
    expect(msg!.body.diff.summary).toContain('required_added');
    expect(msg!.headers['x-gateway-signature']).toBe(
      `sha256=${createHmac('sha256', 's3cr3t').update(msg!.raw).digest('hex')}`,
    );

    // Re-enqueueing the same event (crawl retry, reprocessing) does not resend.
    const events = await h.services.repos.drift.list(tenantId, { kind: 'breaking' });
    expect(await enqueueDriftWebhooks(h.services, tenantId, events)).toBe(0);
    await runCrawl(h.services, { tenantId, sourceId, trigger: 'manual' });
    await new Promise((r) => setTimeout(r, 500));
    expect(received).toHaveLength(1);
  });

  it('cascading drift: breaking base tool → invalidated composite → webhook to the composite owner', async () => {
    const escalas = (await h.services.repos.tools.findByName(tenantId, 'rh_escalas_list'))!;
    const compTool = await h.services.repos.tools.create(tenantId, {
      kind: 'composite',
      name: 'rh_escalas_resumo',
      description: 'composite',
      inputSchema: { type: 'object' },
      state: 'enabled',
      ownerTeam: 'team-rh',
    });
    const def = await h.services.repos.composites.create(tenantId, {
      toolId: compTool.id,
      inputSchema: { type: 'object' },
      steps: [{ id: 'e', tool: 'rh_escalas_list', args: {} }],
      failureMode: 'abort',
      timeoutMs: 5000,
      dependsOnTools: [escalas.id],
      status: 'valid',
    });
    const before = received.length;
    const spec = rhOpenApiSpec('http://up.local') as any;
    spec.components.schemas.NovaMarcacao.required.push('origem');
    spec.paths['/escalas'].get.parameters[0].required = true; // new required → breaking
    await h.services.repos.sources.update(tenantId, sourceId, { openapiInline: spec });
    const run = await runCrawl(h.services, { tenantId, sourceId, trigger: 'manual' });
    expect(run.stats).toMatchObject({ breaking: 1, compositesInvalidated: 1 });

    expect(await h.services.repos.composites.get(tenantId, def.id)).toMatchObject({ status: 'invalid' });
    expect((await h.services.repos.tools.get(tenantId, compTool.id)).state).toBe('disabled');
    await waitFor(async () => received.some((r) => r.body.tool.name === 'rh_escalas_resumo'));
    const msg = received.slice(before).find((r) => r.body.tool.name === 'rh_escalas_resumo')!;
    expect(msg.body).toMatchObject({ kind: 'breaking', tool: { state: 'disabled', ownerTeam: 'team-rh' } });
    expect(msg.body.diff.summary).toContain('composite invalidated: rh_escalas_list');
  });

  it('syncs the sources cron schedules', async () => {
    await h.services.repos.sources.update(tenantId, sourceId, { crawlSchedule: '*/5 * * * *' });
    expect(await syncSchedules(h.services)).toEqual({ upserted: 1, removed: 0 });
    const schedulers = await h.services.queues.crawl.getJobSchedulers();
    expect(schedulers.map((s) => [s.key, s.pattern])).toEqual([[`source:${sourceId}`, '*/5 * * * *']]);
    await h.services.repos.sources.update(tenantId, sourceId, { crawlSchedule: null });
    expect(await syncSchedules(h.services)).toEqual({ upserted: 0, removed: 1 });
  });
});

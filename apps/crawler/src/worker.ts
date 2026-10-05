import {
  CRAWL_JOBS,
  CRAWL_QUEUE,
  WEBHOOK_QUEUE,
  type CrawlAllJob,
  type CrawlSourceJob,
  type DriftWebhookJob,
} from '@mcp-gateway/core';
import { Worker, type Job } from 'bullmq';
import { runCrawl } from './crawl';
import type { CrawlerServices } from './services';
import { deliverDriftWebhook } from './webhooks';

export interface CrawlerWorkers {
  crawl: Worker;
  webhooks: Worker;
  close(): Promise<void>;
}

export function startWorkers(services: CrawlerServices): CrawlerWorkers {
  const connection = services.redis.duplicate({ maxRetriesPerRequest: null });
  const crawl = new Worker(
    CRAWL_QUEUE,
    async (job: Job) => {
      if (job.name === CRAWL_JOBS.crawlSource) {
        const run = await runCrawl(services, job.data as CrawlSourceJob);
        return { runId: run.id, status: run.status };
      }
      if (job.name === CRAWL_JOBS.crawlAll) {
        const data = job.data as CrawlAllJob;
        const sources = await services.repos.system.activeSources(data.tenantId);
        await services.queues.crawl.addBulk(
          sources.map((s) => ({
            name: CRAWL_JOBS.crawlSource,
            data: { tenantId: s.tenantId, sourceId: s.sourceId, trigger: data.trigger } satisfies CrawlSourceJob,
            opts: { removeOnComplete: 1000, removeOnFail: 1000 },
          })),
        );
        return { enqueued: sources.length };
      }
      throw new Error(`unknown job: ${job.name}`);
    },
    { connection, concurrency: services.config.CRAWL_CONCURRENCY },
  );
  const webhookConnection = services.redis.duplicate({ maxRetriesPerRequest: null });
  const webhooks = new Worker(
    WEBHOOK_QUEUE,
    async (job: Job) => deliverDriftWebhook(services, job.data as DriftWebhookJob),
    { connection: webhookConnection, concurrency: 5 },
  );
  for (const w of [crawl, webhooks]) {
    w.on('failed', (job, err) => services.logger.warn({ queue: w.name, jobId: job?.id, err: err.message }, 'job failed'));
  }
  return {
    crawl,
    webhooks,
    async close() {
      await Promise.all([crawl.close(), webhooks.close()]);
      connection.disconnect();
      webhookConnection.disconnect();
    },
  };
}

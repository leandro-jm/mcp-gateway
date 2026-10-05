/** Contract of the queues shared between gateway and crawler. */
export const CRAWL_QUEUE = 'crawl';

export interface CrawlSourceJob {
  tenantId: string;
  sourceId: string;
  /** Run already created (manual crawl via Admin API). Absent in cron jobs: the worker creates the run. */
  runId?: string;
  trigger: 'manual' | 'cron';
}

export interface CrawlAllJob {
  trigger: 'manual' | 'cron';
  /** Restricts to one tenant; absent = every active tenant. */
  tenantId?: string;
}

export const CRAWL_JOBS = {
  crawlSource: 'crawl-source',
  crawlAll: 'crawl-all',
} as const;

/** Pub/sub channel for registry snapshot invalidation (payload: tenantId). */
export const REGISTRY_INVALIDATE_CHANNEL = 'registry:invalidate';
export const registrySnapshotKey = (tenantId: string) => `registry:snapshot:${tenantId}`;
export const registryGenerationKey = (tenantId: string) => `registry:gen:${tenantId}`;

export const WEBHOOK_QUEUE = 'webhooks';

export interface DriftWebhookJob {
  tenantId: string;
  driftEventId: string;
  /** Webhook id in `tenants.settings.webhooks`. */
  hookId: string;
}

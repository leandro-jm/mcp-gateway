import {
  CRAWL_QUEUE,
  decodeKey,
  REGISTRY_INVALIDATE_CHANNEL,
  registryGenerationKey,
  registrySnapshotKey,
  WEBHOOK_QUEUE,
} from '@mcp-gateway/core';
import {
  CompositesRepo,
  CrawlRunsRepo,
  createDb,
  CredentialsRepo,
  DriftEventsRepo,
  Keyring,
  ProjectionsRepo,
  SourcesRepo,
  SystemQueries,
  TenantsRepo,
  ToolsRepo,
  type DbHandle,
} from '@mcp-gateway/db';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { CrawlerConfig } from './config';
import type { Logger } from './logger';

export interface CrawlerServices {
  config: CrawlerConfig;
  logger: Logger;
  dbHandle: DbHandle;
  redis: Redis;
  repos: {
    tenants: TenantsRepo;
    sources: SourcesRepo;
    credentials: CredentialsRepo;
    crawlRuns: CrawlRunsRepo;
    tools: ToolsRepo;
    drift: DriftEventsRepo;
    projections: ProjectionsRepo;
    composites: CompositesRepo;
    system: SystemQueries;
  };
  queues: { crawl: Queue; webhooks: Queue };
  /** Invalidates the tenant's registry snapshot (same protocol as the gateway). */
  invalidateRegistry(tenantId: string): Promise<void>;
  close(): Promise<void>;
}

export function createCrawlerServices(config: CrawlerConfig, logger: Logger): CrawlerServices {
  const dbHandle = createDb(config.DATABASE_URL);
  const db = dbHandle.db;
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const keyring = new Keyring(db, decodeKey(config.GATEWAY_MASTER_KEY));
  const crawl = new Queue(CRAWL_QUEUE, { connection: redis });
  const webhooks = new Queue(WEBHOOK_QUEUE, { connection: redis });
  return {
    config,
    logger,
    dbHandle,
    redis,
    repos: {
      tenants: new TenantsRepo(db),
      sources: new SourcesRepo(db),
      credentials: new CredentialsRepo(db, keyring),
      crawlRuns: new CrawlRunsRepo(db),
      tools: new ToolsRepo(db),
      drift: new DriftEventsRepo(db),
      projections: new ProjectionsRepo(db),
      composites: new CompositesRepo(db),
      system: new SystemQueries(db),
    },
    queues: { crawl, webhooks },
    async invalidateRegistry(tenantId) {
      await redis
        .multi()
        .incr(registryGenerationKey(tenantId))
        .del(registrySnapshotKey(tenantId))
        .publish(REGISTRY_INVALIDATE_CHANNEL, tenantId)
        .exec();
    },
    async close() {
      await Promise.all([crawl.close(), webhooks.close()]);
      redis.disconnect();
      await dbHandle.close();
    },
  };
}

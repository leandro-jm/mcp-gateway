import { Writable } from 'node:stream';
import { generateDataKey } from '@mcp-gateway/core';
import { migrateUp } from '@mcp-gateway/db';
import { startPostgres, startRedis, type StartedPostgres, type StartedRedis } from '@mcp-gateway/testkit';
import { loadConfig } from '../src/config';
import { createLogger } from '../src/logger';
import { createCrawlerServices, type CrawlerServices } from '../src/services';

export interface CrawlerHarness {
  services: CrawlerServices;
  pg: StartedPostgres;
  redis: StartedRedis;
  logs: string[];
  masterKey: string;
  teardown(): Promise<void>;
}

export async function startCrawlerHarness(
  infra?: { pg: StartedPostgres; redis: StartedRedis; masterKey: string },
): Promise<CrawlerHarness> {
  const pg = infra?.pg ?? (await startPostgres());
  const redis = infra?.redis ?? (await startRedis());
  const masterKey = infra?.masterKey ?? generateDataKey().toString('base64');
  const logs: string[] = [];
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'debug',
    DATABASE_URL: pg.url,
    REDIS_URL: redis.url,
    GATEWAY_MASTER_KEY: masterKey,
    WEBHOOK_TIMEOUT_MS: '3000',
    NETWORK_ALLOW_PRIVATE: 'true',
  });
  const logger = createLogger(config.LOG_LEVEL, new Writable({ write: (c, _e, cb) => (logs.push(String(c)), cb()) }));
  const services = createCrawlerServices(config, logger);
  await migrateUp(services.dbHandle.pool);
  return {
    services,
    pg,
    redis,
    logs,
    masterKey,
    async teardown() {
      await services.close();
      if (!infra) await Promise.all([pg.stop(), redis.stop()]);
    },
  };
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 10_000, stepMs = 50): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

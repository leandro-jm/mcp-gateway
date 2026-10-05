import { assertProductionConfig, base64Key32, envBool, envInt, parseEnv } from '@mcp-gateway/core';
import { z } from 'zod';

export const crawlerConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  GATEWAY_MASTER_KEY: base64Key32,
  CRAWL_CONCURRENCY: envInt(2),
  /** Sync interval of the sources' crawl schedules (cron). */
  SCHEDULE_SYNC_INTERVAL_MS: envInt(60_000),
  SPEC_FETCH_TIMEOUT_MS: envInt(15_000),
  SPEC_MAX_BYTES: envInt(10 * 1024 * 1024),
  WEBHOOK_TIMEOUT_MS: envInt(10_000),
  /** SSRF (F11.1): allow specs/tokens/webhooks on private networks. Production: false. */
  NETWORK_ALLOW_PRIVATE: envBool(false),
});

export type CrawlerConfig = z.output<typeof crawlerConfigSchema>;

export const loadConfig = (env: Record<string, string | undefined>) => {
  const config = parseEnv(crawlerConfigSchema, env);
  assertProductionConfig(config);
  return config;
};

import { ConfigError } from '@mcp-gateway/core';
import { loadConfig, type CrawlerConfig } from './config';
import { createLogger } from './logger';
import { syncSchedules } from './scheduler';
import { createCrawlerServices } from './services';
import { startWorkers } from './worker';

function boot(): CrawlerConfig {
  try {
    return loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[mcp-crawler] boot failed. ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

const config = boot();
const logger = createLogger(config.LOG_LEVEL);
const services = createCrawlerServices(config, logger);
const workers = startWorkers(services);

const sync = async () => {
  try {
    const r = await syncSchedules(services);
    logger.debug(r, 'schedules synced');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'failed to sync schedules');
  }
};
await sync();
const timer = setInterval(() => void sync(), config.SCHEDULE_SYNC_INTERVAL_MS);
logger.info('crawler started');

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  clearInterval(timer);
  await workers.close();
  await services.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

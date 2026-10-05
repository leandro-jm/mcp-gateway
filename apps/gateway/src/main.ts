import { ConfigError } from '@mcp-gateway/core';
import { buildApp } from './app';
import { loadConfig, type GatewayConfig } from './config';
import { createLogger } from './logger';
import { runAgentAnalytics } from './analytics/job';
import { runMaintenance } from './maintenance';
import { createServices } from './services';

function boot(): GatewayConfig {
  try {
    return loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[mcp-gateway] boot failed. ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

const config = boot();
const logger = createLogger(config.LOG_LEVEL);
const services = createServices(config, logger);
await services.start();
const app = await buildApp(services);

// Embeddings indexer (F7.1), only with a configured provider.
const indexer = services.search.hybrid
  ? setInterval(async () => {
      for (const tenantId of await services.repos.system.tenantIds().catch(() => [])) {
        await services.search.refreshEmbeddings(tenantId).catch((err: unknown) => logger.warn({ err, tenantId }, 'embeddings indexing failed'));
      }
    }, 60_000)
  : undefined;

void runMaintenance(services).catch((err: unknown) => logger.warn({ err }, 'initial maintenance failed'));
const maintenance = setInterval(() => {
  runMaintenance(services).catch((err: unknown) => logger.warn({ err }, 'maintenance failed'));
}, 5 * 60_000);
maintenance.unref();

// Agent analytics (F15.21): findings, co-usage and composite suggestions.
const agentAnalytics = setInterval(() => {
  runAgentAnalytics(services).catch((err: unknown) => logger.warn({ err }, 'agent analytics failed'));
}, 15 * 60_000);
agentAnalytics.unref();

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  clearInterval(maintenance);
  clearInterval(agentAnalytics);
  if (indexer) clearInterval(indexer);
  await app.close();
  await services.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });

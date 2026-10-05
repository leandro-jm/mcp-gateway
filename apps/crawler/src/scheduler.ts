import { CRAWL_JOBS, type CrawlSourceJob } from '@mcp-gateway/core';
import type { CrawlerServices } from './services';

const PREFIX = 'source:';

/**
 * Syncs the BullMQ job schedulers with `upstream_sources.crawl_schedule`:
 * creates/updates one scheduler per scheduled source and removes orphans.
 */
export async function syncSchedules(services: CrawlerServices): Promise<{ upserted: number; removed: number }> {
  const queue = services.queues.crawl;
  const scheduled = await services.repos.system.scheduledSources();
  const wanted = new Set<string>();
  for (const s of scheduled) {
    const id = `${PREFIX}${s.sourceId}`;
    wanted.add(id);
    const data: CrawlSourceJob = { tenantId: s.tenantId, sourceId: s.sourceId, trigger: 'cron' };
    try {
      await queue.upsertJobScheduler(id, { pattern: s.crawlSchedule! }, { name: CRAWL_JOBS.crawlSource, data, opts: { removeOnComplete: 100, removeOnFail: 100 } });
    } catch (err) {
      services.logger.warn({ sourceId: s.sourceId, schedule: s.crawlSchedule, err: (err as Error).message }, 'invalid schedule');
      wanted.delete(id);
    }
  }
  let removed = 0;
  for (const existing of await queue.getJobSchedulers(0, -1)) {
    if (existing.key.startsWith(PREFIX) && !wanted.has(existing.key)) {
      await queue.removeJobScheduler(existing.key);
      removed += 1;
    }
  }
  return { upserted: wanted.size, removed };
}

import { assertOutboundUrl, CRAWL_JOBS, effectiveNetworkPolicy, OutboundBlocked, ValidationError, type CrawlSourceJob, type NetworkPolicy } from '@mcp-gateway/core';
import type { CrawlRun } from '@mcp-gateway/db';
import { msg } from '@mcp-gateway/i18n/server';
import type { Services } from '../services';

/** Network policy of the tenant (SSRF, F11.1). */
export async function tenantNetworkPolicy(services: Services, tenantId: string): Promise<NetworkPolicy> {
  const tenant = await services.repos.tenants.get(tenantId);
  return effectiveNetworkPolicy(services.config.NETWORK_ALLOW_PRIVATE, tenant.settings);
}

/** SSRF (F11.1): base URL and spec only for destinations allowed by the tenant policy. */
export async function assertAllowedUrls(services: Services, tenantId: string, urls: Array<string | null | undefined>): Promise<void> {
  const policy = await tenantNetworkPolicy(services, tenantId);
  for (const u of urls) {
    if (!u) continue;
    try {
      assertOutboundUrl(u, policy);
    } catch (err) {
      if (err instanceof OutboundBlocked) throw new ValidationError(msg('admin.urlNotAllowed', { reason: err.msg }), { url: u });
      throw err;
    }
  }
}

/** Creates a `queued` crawl run and enqueues `crawl-source` (ADR-008). */
export async function enqueueCrawl(services: Services, tenantId: string, sourceId: string): Promise<CrawlRun> {
  const run = await services.repos.crawlRuns.create(tenantId, sourceId, 'manual');
  const job: CrawlSourceJob = { tenantId, sourceId, runId: run.id, trigger: 'manual' };
  await services.queues.crawl.add(CRAWL_JOBS.crawlSource, job, { jobId: run.id, removeOnComplete: 1000, removeOnFail: 1000 });
  return run;
}

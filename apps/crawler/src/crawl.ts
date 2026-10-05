import { importPostman } from '@mcp-gateway/api-import';
import { effectiveNetworkPolicy, type CrawlSourceJob } from '@mcp-gateway/core';
import type { CrawlRun } from '@mcp-gateway/db';
import { isMessage } from '@mcp-gateway/i18n';
import { msg, raw, translate, type ServerMessage } from '@mcp-gateway/i18n/server';
import { generateTools, parseSpec } from '@mcp-gateway/openapi-toolgen';
import { registerTools } from './register';
import type { CrawlerServices } from './services';
import { fetchSpec } from '@mcp-gateway/net';
import { enqueueDriftWebhooks } from './webhooks';

/** Max length of untranslatable error text kept in `error_params`. */
const MAX_RAW_ERROR = 2000;

/** The failure as a translatable message: errors that carry one (`GatewayError`, `SpecError`…) keep it. */
export function crawlErrorMessage(err: unknown): ServerMessage {
  const m = (err as { msg?: unknown } | null)?.msg;
  if (isMessage(m)) return m as ServerMessage;
  return raw((err instanceof Error ? err.message : String(err)).slice(0, MAX_RAW_ERROR));
}

/** Runs a source crawl and records the result in `crawl_runs`. */
/** Crawl failure with a translatable message. */
export class CrawlError extends Error {
  constructor(readonly msg: ServerMessage) {
    super(translate(msg));
    this.name = 'CrawlError';
  }
}

export async function runCrawl(services: CrawlerServices, job: CrawlSourceJob): Promise<CrawlRun> {
  const { repos, config, logger } = services;
  const run = job.runId
    ? await repos.crawlRuns.get(job.tenantId, job.runId)
    : await repos.crawlRuns.create(job.tenantId, job.sourceId, job.trigger);
  const log = logger.child({ runId: run.id, tenantId: job.tenantId, sourceId: job.sourceId });
  await repos.crawlRuns.markRunning(job.tenantId, run.id);
  const started = Date.now();
  try {
    const source = await repos.sources.get(job.tenantId, job.sourceId);
    let raw: unknown = source.openapiInline;
    if (!raw) {
      if (!source.openapiUrl) throw new CrawlError(msg('crawler.noSpecSource'));
      const credential = source.credentialId
        ? await repos.credentials.getDecrypted(job.tenantId, source.credentialId)
        : undefined;
      const tenant = await repos.tenants.get(job.tenantId);
      raw = await fetchSpec(source.openapiUrl, {
        timeoutMs: config.SPEC_FETCH_TIMEOUT_MS,
        maxBytes: config.SPEC_MAX_BYTES,
        network: effectiveNetworkPolicy(config.NETWORK_ALLOW_PRIVATE, tenant.settings),
        ...(credential ? { credential } : {}),
      });
    }
    // Postman collection behind the URL (ADR-014): converted on every crawl so drift keeps working
    if (source.specFormat === 'postman') raw = importPostman(raw).openapi;
    const spec = await parseSpec(raw);
    const generated = generateTools(spec, { sourceName: source.name });
    const result = await registerTools({ tools: repos.tools, drift: repos.drift, projections: repos.projections, composites: repos.composites }, job.tenantId, source, generated);
    await repos.sources.markCrawled(job.tenantId, source.id);
    await services.invalidateRegistry(job.tenantId);
    const webhooks = await enqueueDriftWebhooks(services, job.tenantId, result.driftEvents);
    const stats = {
      specVersion: spec.specVersion,
      specFormat: source.specFormat,
      operations: spec.operations.length,
      generated: generated.tools.length,
      skipped: generated.skipped.length,
      ...result.stats,
      driftEvents: result.driftEvents.length,
      webhooksEnqueued: webhooks,
      durationMs: Date.now() - started,
    };
    await repos.crawlRuns.finish(job.tenantId, run.id, { status: 'succeeded', stats });
    log.info({ stats }, 'crawl finished');
  } catch (err) {
    const error = crawlErrorMessage(err);
    await repos.crawlRuns.finish(job.tenantId, run.id, {
      status: 'failed',
      error,
      stats: { durationMs: Date.now() - started },
    });
    log.warn({ err: (err as Error).message, errorKey: error.key }, 'crawl failed');
  }
  return repos.crawlRuns.get(job.tenantId, run.id);
}

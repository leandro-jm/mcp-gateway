import { createHmac } from 'node:crypto';
import { effectiveNetworkPolicy, readWebhooks, type DriftWebhook, type DriftWebhookJob } from '@mcp-gateway/core';
import { outboundFetch } from '@mcp-gateway/net';
import type { DriftEvent, Tool } from '@mcp-gateway/db';
import type { CrawlerServices } from './services';

/** Idempotency key: each (drift_event, webhook) pair is enqueued only once. */
const sentKey = (eventId: string, hookId: string) => `drift:webhook:${eventId}:${hookId}`;
const IDEMPOTENCY_TTL_SECONDS = 30 * 24 * 3600;

function matches(hook: DriftWebhook, event: DriftEvent, tool: Pick<Tool, 'ownerTeam'>): boolean {
  if (!hook.events.includes(event.kind)) return false;
  return !hook.ownerTeam || hook.ownerTeam === tool.ownerTeam;
}

/** Enqueues drift notifications for the webhooks configured in the tenant. */
export async function enqueueDriftWebhooks(
  services: CrawlerServices,
  tenantId: string,
  events: DriftEvent[],
): Promise<number> {
  if (!events.length) return 0;
  const tenant = await services.repos.tenants.get(tenantId);
  const hooks = readWebhooks(tenant.settings);
  if (!hooks.length) return 0;
  let enqueued = 0;
  for (const event of events) {
    const tool = await services.repos.tools.get(tenantId, event.toolId);
    for (const hook of hooks) {
      if (!matches(hook, event, tool)) continue;
      const first = await services.redis.set(sentKey(event.id, hook.id), '1', 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX');
      if (first !== 'OK') continue;
      const job: DriftWebhookJob = { tenantId, driftEventId: event.id, hookId: hook.id };
      await services.queues.webhooks.add('drift', job, {
        jobId: `drift-${event.id}-${hook.id}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      });
      enqueued += 1;
    }
  }
  return enqueued;
}

export function signPayload(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** Delivers a drift webhook (processor of the `webhooks` queue). */
export async function deliverDriftWebhook(services: CrawlerServices, job: DriftWebhookJob): Promise<void> {
  const tenant = await services.repos.tenants.get(job.tenantId);
  const hook = readWebhooks(tenant.settings).find((h) => h.id === job.hookId);
  if (!hook) return; // webhook removed after being enqueued
  const event = await services.repos.drift.get(job.tenantId, job.driftEventId);
  const tool = await services.repos.tools.get(job.tenantId, event.toolId);
  const diff = event.diff as { summary?: string; fromVersion?: number | null; toVersion?: number; breaking?: boolean };
  const payload = {
    type: 'tool.drift',
    id: event.id,
    kind: event.kind,
    createdAt: event.createdAt.toISOString(),
    tenant: { id: tenant.id, slug: tenant.slug },
    tool: { id: tool.id, name: tool.name, state: tool.state, ownerTeam: tool.ownerTeam, sourceId: tool.sourceId },
    diff: { summary: diff.summary, fromVersion: diff.fromVersion ?? null, toVersion: diff.toVersion ?? null, breaking: diff.breaking ?? event.kind === 'breaking' },
  };
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'mcp-gateway-webhooks/1',
    'x-gateway-event': 'tool.drift',
    'x-gateway-delivery': event.id,
  };
  if (hook.secret) headers['x-gateway-signature'] = signPayload(hook.secret, body);
  const res = await outboundFetch(
    hook.url,
    { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(services.config.WEBHOOK_TIMEOUT_MS) },
    effectiveNetworkPolicy(services.config.NETWORK_ALLOW_PRIVATE, tenant.settings),
  );
  if (!res.ok) throw new Error(`webhook ${hook.id} responded HTTP ${res.status}`);
}

import type { JsonObject } from '@mcp-gateway/db';
import { syntheticTools } from '@mcp-gateway/testkit';
import type { DecisionRequest } from '@mcp-gateway/tool-router';
import type { Harness } from './harness';

/** Tenant with the 200 synthetic tools (manual, no upstream) and `agent` allowed on everything. */
export async function seedSyntheticTenant(h: Harness, slug: string): Promise<string> {
  const tenant = (await h.services.repos.tenants.findBySlug(slug)) ?? (await h.services.repos.tenants.create({ slug, name: slug }));
  for (const t of syntheticTools()) {
    await h.services.repos.tools.create(tenant.id, { kind: 'manual', ...t, state: 'enabled' });
  }
  await h.services.repos.policies.create(tenant.id, { subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: '*' });
  await h.services.repos.policies.create(tenant.id, { subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: '*_delete' });
  await h.services.registry.invalidate(tenant.id);
  return tenant.id;
}

/** Replaces `settings.toolRouter` (undefined removes it) and invalidates the snapshot. */
export async function setRouter(h: Harness, tenantId: string, toolRouter: JsonObject | undefined): Promise<void> {
  const { settings } = await h.services.repos.tenants.get(tenantId);
  const { toolRouter: _old, ...rest } = settings as JsonObject;
  await h.services.repos.tenants.update(tenantId, { settings: toolRouter ? { ...rest, toolRouter } : rest });
  await h.services.registry.invalidate(tenantId);
}

export async function setProvider(h: Harness, tenantId: string, provider: 'openai_decisions' | 'jev' = 'openai_decisions', baseUrl: string | null = null): Promise<void> {
  await h.services.repos.decisionSettings.upsert(tenantId, { provider, model: provider === 'jev' ? 'jev-latest' : 'gpt-6-luna', baseUrl, apiKey: 'sk-test-decisions-key-000000' }, 'test');
  h.services.router?.forgetTenant(tenantId);
}

/** Router columns of the tenant's call events, oldest first. */
export async function routerEvents(h: Harness, tenantId: string, kind?: string) {
  await h.services.callEvents.flush();
  const { rows } = await h.services.dbHandle.pool.query(
    `SELECT kind, tool_name, plugins, gate, plugins_ms, meta, catalog_tokens, decision, error_code FROM call_events WHERE tenant_id = $1 ${kind ? 'AND kind = $2' : ''} ORDER BY ts`,
    kind ? [tenantId, kind] : [tenantId],
  );
  return rows as Array<{ kind: string; tool_name: string; plugins: any[] | null; gate: any; plugins_ms: number | null; meta: any; catalog_tokens: number | null; decision: string; error_code: string | null }>;
}

/** Tool name inside a choice option description (`Title (name): …` or `name: …`). */
export function optionTool(req: DecisionRequest, option: string): string | undefined {
  const q = req.questions.find((x) => x.type === 'choice');
  const d = q?.type === 'choice' ? q.choices.find((c) => c.value === option)?.description : undefined;
  return d ? (/\(([a-z0-9_]+)\):/.exec(d)?.[1] ?? d.split(':')[0]) : undefined;
}

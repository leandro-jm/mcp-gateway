/**
 * Undoes `env:setup` from its snapshot (results/snapshot-<gateway>-<tenant>.json, ADR-027).
 *
 *   pnpm --filter @mcp-gateway/bench env:restore [--disable-tools] [--remove-bench]
 *
 * Always: tool router settings and rate limits back to the snapshot, `bench-agent` tokens revoked.
 * --disable-tools: disables the tools that were not enabled before the setup.
 * --remove-bench: deletes the benchmark policy, virtual servers and service user.
 * The Jev key cannot be restored (the API never returns keys): it is removed if there was no provider before.
 */
import { adminClient, findTenant, type PolicyDto, type ToolDto, type ToolRouterView, type UserDto, type VirtualServerDto } from '../src/admin';
import { out, required } from '../src/env';
import { readJson, snapshotFile } from '../src/files';
import { SERVERS } from '../src/mcp';
import { putRouterSettings } from '../src/router';

interface Snapshot {
  takenAt: string;
  tenant: { id: string; slug: string; settings: Record<string, unknown> };
  sourceId: string;
  enabledToolIds: string[];
  router: ToolRouterView;
}

const AGENT = 'bench-agent';
const baseUrl = required('BENCH_GATEWAY_URL');
const snap = readJson<Snapshot>(snapshotFile(baseUrl, required('BENCH_TENANT')));
const admin = adminClient(baseUrl, required('BENCH_ADMIN_TOKEN'), snap.tenant.slug);
out(`restoring tenant ${snap.tenant.slug} to the snapshot of ${snap.takenAt}`);

await putRouterSettings(admin, snap.router.settings);
if (!snap.router.provider.configured) await admin.del('/settings/tool-router/provider').catch(() => undefined);
out('router: settings restored');

// after the router: PATCH /tenants replaces the whole settings object
const tenant = await findTenant(admin);
await admin.patch(`/tenants/${tenant.id}`, { settings: { ...tenant.settings, rateLimits: snap.tenant.settings.rateLimits } });
out('rate limits: restored');

const agent = (await admin.listAll<UserDto>('/users')).find((u) => u.username === AGENT);
if (agent) {
  for (const t of (await admin.get<{ items: Array<{ id: string; name: string }> }>(`/users/${agent.id}/tokens`)).items) {
    await admin.del(`/users/${agent.id}/tokens/${t.id}`);
  }
  out('agent: tokens revoked');
}

if (process.argv.includes('--disable-tools')) {
  const before = new Set(snap.enabledToolIds);
  const now = await admin.listAll<ToolDto>(`/tools?sourceId=${snap.sourceId}&state=enabled`);
  for (const t of now.filter((x) => !before.has(x.id))) await admin.post(`/tools/${t.id}/disable`);
  out(`tools: ${now.filter((x) => !before.has(x.id)).length} disabled`);
}

if (process.argv.includes('--remove-bench')) {
  for (const p of (await admin.get<{ items: PolicyDto[] }>('/policies')).items) {
    if (p.subjectType === 'client' && p.subject === AGENT) await admin.del(`/policies/${p.id}`);
  }
  for (const s of (await admin.get<{ items: VirtualServerDto[] }>('/virtual-servers')).items) {
    if (s.slug === SERVERS.full || s.slug === SERVERS.omni) await admin.del(`/virtual-servers/${s.id}`);
  }
  if (agent) await admin.del(`/users/${agent.id}`);
  out('benchmark policy, servers and user removed');
}
out('restore done');

/**
 * Prepares the tenant for the benchmark (ADR-027). Idempotent: re-running only does what is missing.
 *
 *   pnpm --filter @mcp-gateway/bench env:setup [--allow-exposure]
 *
 * 1. snapshot of the tenant before any change (results/snapshot-<gateway>-<tenant>.json, written once);
 * 2. exposure check: simulates the existing policies for every user and token of the tenant against
 *    the disabled tools, and stops if enabling them would expose any to someone else;
 * 3. enables every tool of the source; 4. service user `bench-agent` + token (saved to .env);
 * 5. `allow` policy for that token only; 6. virtual servers `bench-full` and `bench-omni`;
 * 7. Jev decision provider, router left off; 8. higher rate limits; 9. MCP check with the agent token.
 */
import { existsSync } from 'node:fs';
import {
  adminClient,
  findSource,
  findTenant,
  type Decision,
  type PolicyDto,
  type ToolDto,
  type UserDto,
  type VirtualServerDto,
} from '../src/admin';
import { optional, out, required } from '../src/env';
import { readJson, setEnvValue, snapshotFile, writeJson } from '../src/files';
import { callMcpTool, connectScenario, listAllTools, SCENARIOS, SERVERS } from '../src/mcp';
import { routerView } from '../src/router';

const AGENT = 'bench-agent';
const allowExposure = process.argv.includes('--allow-exposure');

const baseUrl = required('BENCH_GATEWAY_URL');
const admin = adminClient(baseUrl, required('BENCH_ADMIN_TOKEN'), required('BENCH_TENANT'));
const tenant = await findTenant(admin);
const source = await findSource(admin, required('BENCH_SOURCE_NAME'));
const sourceTools = (await admin.listAll<ToolDto>(`/tools?sourceId=${source.id}`)).filter((t) => t.state !== 'removed');
const prefix = `${source.name}_`;
out(`tenant ${tenant.slug}, source ${source.name}: ${sourceTools.length} tools`);

const outside = sourceTools.filter((t) => !t.name.startsWith(prefix));
if (outside.length) throw new Error(`tools without the "${prefix}" prefix (renamed?): ${outside.map((t) => t.name).join(', ')}`);
if (prefix.length < 3) throw new Error(`prefix "${prefix}" is too short for a policy that covers destructive tools (needs 3+ literal chars)`);

// 1. snapshot, once per gateway and tenant: it is what `env:restore` goes back to
const snapshot = snapshotFile(baseUrl, tenant.slug);
if (existsSync(snapshot)) {
  out(`snapshot: kept ${snapshot} from ${readJson<{ takenAt: string }>(snapshot).takenAt}`);
} else {
  writeJson(snapshot, {
    takenAt: new Date().toISOString(),
    tenant: { id: tenant.id, slug: tenant.slug, settings: tenant.settings },
    sourceId: source.id,
    enabledToolIds: (await admin.listAll<ToolDto>('/tools?state=enabled')).map((t) => t.id),
    policies: (await admin.get<{ items: PolicyDto[] }>('/policies')).items,
    router: await routerView(admin),
    virtualServers: (await admin.get<{ items: VirtualServerDto[] }>('/virtual-servers')).items,
  });
  out(`snapshot: ${snapshot}`);
}

// 2. exposure check over the tools that are about to be enabled
const toEnable = sourceTools.filter((t) => t.state !== 'enabled');
const sample = [...toEnable.filter((t) => t.annotations.destructiveHint).slice(0, 5), ...toEnable.filter((t) => !t.annotations.destructiveHint).slice(0, 15)];
const users = (await admin.listAll<UserDto>('/users')).filter((u) => u.username !== AGENT);
const exposures: string[] = [];
for (const u of users) {
  const tokens = (await admin.get<{ items: Array<{ name: string }> }>(`/users/${u.id}/tokens`)).items;
  for (const clientId of [undefined, ...tokens.map((t) => t.name)]) {
    for (const t of sample) {
      const d = await admin.post<Decision>('/policies/simulate', {
        subject: { sub: u.username, roles: u.roles, groups: u.groups, ...(clientId ? { clientId } : {}) },
        tool: t.name,
        mode: 'list',
      });
      if (d.effect === 'allow') exposures.push(`${u.username}${clientId ? ` (token ${clientId})` : ''} → ${t.name} (rule ${d.ruleId})`);
    }
  }
}
if (exposures.length) {
  out(`exposure: enabling would make tools visible to other subjects:\n  ${exposures.slice(0, 30).join('\n  ')}`);
  if (!allowExposure) throw new Error('stopped before enabling tools; review the policies or re-run with --allow-exposure');
} else {
  out(`exposure: none (${users.length} users, ${sample.length} sample tools)`);
}

// 3. enable every tool of the source
let enabled = 0;
const failed: string[] = [];
for (const t of toEnable) {
  try {
    await admin.post(`/tools/${t.id}/enable`);
    enabled++;
    if (enabled % 20 === 0) out(`  enabled ${enabled}/${toEnable.length}`);
  } catch (err) {
    failed.push(`${t.name}: ${(err as Error).message}`);
  }
}
const total = (await admin.get<{ total: number }>(`/tools?sourceId=${source.id}&state=enabled&limit=1`)).total;
out(`tools: ${enabled} enabled now, ${total}/${sourceTools.length} enabled in total`);
if (failed.length) out(`  failed:\n  ${failed.join('\n  ')}`);

// 4. service user + token
let agent = (await admin.listAll<UserDto>('/users')).find((u) => u.username === AGENT);
agent ??= await admin.post<UserDto>('/users', { username: AGENT, displayName: 'MCP Gateway benchmark (ADR-027)', kind: 'service', roles: ['agent'] });
/** A token left in .env by another gateway (a local rehearsal) must not be taken as valid here. */
async function tokenWorks(token: string): Promise<boolean> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/mcp/s/${SERVERS.full}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  return res.status !== 401 && res.status !== 403;
}
let agentToken = optional('BENCH_AGENT_TOKEN');
if (agentToken && !(await tokenWorks(agentToken))) {
  out('agent: BENCH_AGENT_TOKEN in .env is not valid on this gateway; issuing a new one');
  agentToken = undefined;
}
if (!agentToken) {
  for (const old of (await admin.get<{ items: Array<{ id: string; name: string }> }>(`/users/${agent.id}/tokens`)).items) {
    if (old.name === AGENT) await admin.del(`/users/${agent.id}/tokens/${old.id}`);
  }
  agentToken = (await admin.post<{ token: string }>(`/users/${agent.id}/tokens`, { name: AGENT, expiresInDays: 14 })).token;
  setEnvValue('BENCH_AGENT_TOKEN', agentToken);
  out(`agent: token created and saved to apps/bench/${process.env.BENCH_ENV_FILE ?? '.env'} (BENCH_AGENT_TOKEN)`);
} else {
  out('agent: using BENCH_AGENT_TOKEN from .env');
}

// 5. policy bound to the agent token; `<source>_*` has 3+ literal chars, so it also covers destructive tools
const toolPattern = `${prefix}*`;
const policies = (await admin.get<{ items: PolicyDto[] }>('/policies')).items;
if (!policies.some((p) => p.subjectType === 'client' && p.subject === AGENT && p.effect === 'allow' && p.toolPattern === toolPattern)) {
  await admin.post('/policies', { subjectType: 'client', subject: AGENT, effect: 'allow', toolPattern, description: 'MCP Gateway benchmark (ADR-027)' });
  out(`policy: allow client ${AGENT} → ${toolPattern}`);
}
for (const t of [sourceTools.find((x) => x.annotations.readOnlyHint), sourceTools.find((x) => x.annotations.destructiveHint)]) {
  if (!t) continue;
  const d = await admin.post<Decision>('/policies/simulate', { subject: { sub: AGENT, roles: ['agent'], clientId: AGENT }, tool: t.name, mode: 'call' });
  if (d.effect !== 'allow') throw new Error(`policy check: ${AGENT} is denied ${t.name} (${d.reason})`);
}

// 6. virtual servers
// `kinds` restricts the pattern to the source's own kinds (e.g. leaves out composites named with the prefix)
const toolSelector = { patterns: [toolPattern], kinds: [...new Set(sourceTools.map((t) => t.kind))].sort() };
const servers = (await admin.get<{ items: VirtualServerDto[] }>('/virtual-servers')).items;
for (const [slug, mode] of [
  [SERVERS.full, 'full'],
  [SERVERS.omni, 'omni'],
] as const) {
  const body = { slug, name: `Benchmark (${mode})`, description: 'MCP Gateway benchmark (ADR-027)', toolSelector, mode };
  const existing = servers.find((s) => s.slug === slug);
  if (!existing) await admin.post('/virtual-servers', body);
  else if (existing.mode !== mode || JSON.stringify(existing.toolSelector) !== JSON.stringify(toolSelector)) await admin.patch(`/virtual-servers/${existing.id}`, body);
}
out(`servers: /mcp/s/${SERVERS.full}, /mcp/s/${SERVERS.omni}`);

// 8 before 7: PATCH /tenants replaces the whole settings object, so it goes first, from a fresh read
const fresh = await findTenant(admin);
const rateLimits = (fresh.settings.rateLimits ?? {}) as Record<string, unknown>;
await admin.patch(`/tenants/${fresh.id}`, {
  settings: {
    ...fresh.settings,
    rateLimits: { ...rateLimits, perTenant: { limit: 20000, windowSec: 60 }, perClient: { limit: 6000, windowSec: 60 }, perTool: { limit: 6000, windowSec: 60 } },
  },
});
out('rate limits: 20000/min per tenant, 6000/min per client and per tool');

// 7. decision provider (scenarios C and D); the router stays off until phase 2
const jevKey = optional('JEV_API_KEY');
const view = await routerView(admin);
if (!view.platformEnabled) out('router: WARNING TOOL_ROUTER_ENABLED is false on this gateway; scenarios C and D cannot run');
if (jevKey) {
  const model = optional('JEV_MODEL');
  const jevUrl = optional('JEV_BASE_URL');
  await admin.put('/settings/tool-router/provider', { provider: 'jev', apiKey: jevKey, ...(model ? { model } : {}), baseUrl: jevUrl ?? null });
  const test = await admin.post<{ ok: boolean; latencyMs?: number; error?: string }>('/settings/tool-router/test', {});
  if (!test.ok) throw new Error(`router: provider test failed: ${test.error}`);
  out(`router: Jev provider ok (${test.latencyMs} ms)`);
} else if (!view.provider.configured) {
  out('router: WARNING no JEV_API_KEY and no provider configured; scenarios C and D cannot run');
}
await admin.put('/settings/tool-router', { ...(await routerView(admin)).settings, enabled: false });

// 9. MCP check with the agent token
const probe = { id: 'setup', group: 'single' as const, prompt: '', expected: [] };
for (const scenario of [SCENARIOS.A, SCENARIOS.B]) {
  const client = await connectScenario(baseUrl, agentToken, scenario, probe, 'setup');
  try {
    const tools = await listAllTools(client);
    if (scenario.omni) {
      const r = await callMcpTool(client, 'search_tools', { query: sourceTools[0]?.description.slice(0, 80) ?? source.name });
      if (r.isError) throw new Error(`search_tools failed: ${r.text}`);
      out(`mcp: ${scenario.server} lists ${tools.map((t) => t.name).join(', ')}; search_tools ok`);
    } else {
      const domain = tools.filter((t) => t.name.startsWith(prefix)).length;
      out(`mcp: ${scenario.server} lists ${tools.length} tools (${domain} of the source, ${tools.length - domain} of the gateway)`);
      if (domain !== total) out(`  WARNING expected ${total} tools of the source`);
    }
  } finally {
    await client.close();
  }
}
out('setup done');

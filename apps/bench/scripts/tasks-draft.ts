/**
 * Writes the catalog of the source's tools, grouped by resource, as the starting point of the answer
 * key (tasks/tasks.jsonl). Reads only.
 *
 *   pnpm --filter @mcp-gateway/bench tasks:draft
 *
 * Output: results/catalog.json (name, description, parameters, hints) and results/catalog.md.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adminClient, findSource, type ToolDto } from '../src/admin';
import { out, required } from '../src/env';
import { RESULTS_DIR, writeJson } from '../src/files';

const admin = adminClient(required('BENCH_GATEWAY_URL'), required('BENCH_ADMIN_TOKEN'), required('BENCH_TENANT'));
const source = await findSource(admin, required('BENCH_SOURCE_NAME'));
const tools = (await admin.listAll<ToolDto>(`/tools?sourceId=${source.id}`)).filter((t) => t.state !== 'removed');
const prefix = `${source.name}_`;

const params = (t: ToolDto) => {
  const props = (t.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
  const req = new Set((t.inputSchema.required ?? []) as string[]);
  return Object.entries(props).map(([k, v]) => `${k}${req.has(k) ? '*' : ''}:${v.type ?? '?'}`);
};
const resource = (name: string) => name.slice(prefix.length).replace(/_(list|get|create|update|delete|search|patch)$/, '');

const catalog = tools.map((t) => ({
  name: t.name,
  resource: resource(t.name),
  description: t.description,
  params: params(t),
  readOnly: t.annotations.readOnlyHint ?? false,
  destructive: t.annotations.destructiveHint ?? false,
}));
writeJson(join(RESULTS_DIR, 'catalog.json'), catalog);

const byResource = new Map<string, typeof catalog>();
for (const c of catalog) byResource.set(c.resource, [...(byResource.get(c.resource) ?? []), c]);
const md = [`# ${source.name}: ${tools.length} tools, ${byResource.size} resources`, ''];
for (const [r, items] of [...byResource].sort(([a], [b]) => a.localeCompare(b))) {
  md.push(`## ${r}`);
  for (const c of items) md.push(`- \`${c.name}\`${c.destructive ? ' (destructive)' : c.readOnly ? ' (read)' : ''}: ${c.description.split('\n')[0]?.slice(0, 160)} — ${c.params.join(', ')}`);
  md.push('');
}
writeFileSync(join(RESULTS_DIR, 'catalog.md'), md.join('\n'));
out(`${tools.length} tools in ${byResource.size} resources → results/catalog.json, results/catalog.md`);

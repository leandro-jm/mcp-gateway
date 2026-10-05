/**
 * Generic MCP client against the gateway (F11.4): uses a static API token (ADR-011),
 * connects over Streamable HTTP and solves a task through Omni (search → schema → call).
 *
 *   MCP_GATEWAY_TOKEN=mgw_dev-agent-token-somente-para-desenvolvimento GATEWAY_URL=http://localhost:4000 \
 *   pnpm tsx examples/mcp-client.ts "details of employee col-00001"
 *
 * In dev, the token above is created by `pnpm db:seed` (service user `agent-dev`).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (!v) throw new Error(`set ${k}`);
  return v;
};

const task = process.argv[2] ?? 'get the details of an employee (colaborador) by id';
const client = new Client({ name: 'generic-example', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${env('GATEWAY_URL', 'http://localhost:4000')}/mcp/omni`), {
    requestInit: { headers: { authorization: `Bearer ${env('MCP_GATEWAY_TOKEN')}` } },
  }),
);

const found = await client.callTool({ name: 'search_tools', arguments: { query: task, limit: 3 } });
const results = (found.structuredContent as { results: Array<{ name: string; description: string }> }).results;
console.log('search_tools →', results.map((r) => r.name));
const best = results[0];
if (!best) throw new Error('no tool found');
const schema = await client.callTool({ name: 'get_tool_schema', arguments: { name: best.name } });
const required = ((schema.structuredContent as { inputSchema: { required?: string[] } }).inputSchema.required ?? []) as string[];
const args = Object.fromEntries(required.map((k) => [k, process.env[`ARG_${k.toUpperCase()}`] ?? 'col-00001']));
const result = await client.callTool({ name: 'call_tool', arguments: { name: best.name, arguments: args } });
console.log(`call_tool ${best.name}(${JSON.stringify(args)}) →`, JSON.stringify(result.structuredContent ?? result.content).slice(0, 400));
await client.close();

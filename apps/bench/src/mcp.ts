import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation';
import type { ScenarioId, Task } from './types';

/**
 * The agent must see exactly what the gateway returns, so the client does not validate `outputSchema`
 * (the SDK default compiles it with Ajv, warns on custom formats like `cbo` and throws on mismatches).
 */
const acceptAll: jsonSchemaValidator = {
  getValidator: () => (input) => ({ valid: true, data: input as never, errorMessage: undefined }),
};

/** Gateway `_meta` key carrying the call id of a `tools/call` (apps/gateway/src/proxy/executor.ts). */
export const CALL_ID_META = 'io.github.leandro-jm.mcp-gateway/call-id';
export const INTENT_HEADER = 'mcp-gateway-intent';
/** Omni discovery and gateway artifact tools count as meta calls; `call_tool` is unwrapped into its domain tool. */
export const META_TOOLS: ReadonlySet<string> = new Set(['search_tools', 'get_tool_schema', 'report_outcome', 'artifact_read', 'artifact_query']);
export const CALL_TOOL = 'call_tool';

export const SERVERS = { full: 'bench-full', omni: 'bench-omni' } as const;

export interface Scenario {
  id: ScenarioId;
  phase: 1 | 2;
  server: (typeof SERVERS)[keyof typeof SERVERS];
  omni: boolean;
  intent: boolean;
  label: string;
}

export const SCENARIOS: Record<ScenarioId, Scenario> = {
  A: { id: 'A', phase: 1, server: SERVERS.full, omni: false, intent: false, label: 'Direto (todas as tools)' },
  B: { id: 'B', phase: 1, server: SERVERS.omni, omni: true, intent: false, label: 'Omni (FTS)' },
  C: { id: 'C', phase: 2, server: SERVERS.omni, omni: true, intent: false, label: 'Omni + rerank' },
  D: { id: 'D', phase: 2, server: SERVERS.full, omni: false, intent: true, label: 'Shortlist por intenção' },
};

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface CallOutcome {
  text: string;
  isError: boolean;
  errorCode: string | null;
  callId: string | null;
}

/** One client per run: `clientInfo.name` = `bench-<scenario>` correlates with `/admin/v1/calls?agent=`. */
export async function connectScenario(baseUrl: string, token: string, scenario: Scenario, task: Task, runId: string): Promise<Client> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (scenario.intent && task.intent) headers[INTENT_HEADER] = encodeURIComponent(task.intent);
  const client = new Client({ name: `bench-${scenario.id}`, version: runId }, { jsonSchemaValidator: acceptAll });
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/mcp/s/${scenario.server}`);
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  return client;
}

export async function listAllTools(client: Client): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> })));
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

/** Gateway tool errors are `{"error": "<CODE>", "message": ...}` JSON text (packages/core/src/errors.ts). */
function errorCodeOf(text: string): string | null {
  try {
    const v = JSON.parse(text) as { error?: unknown };
    return typeof v.error === 'string' ? v.error : null;
  } catch {
    return null;
  }
}

export async function callMcpTool(client: Client, name: string, args: Record<string, unknown>): Promise<CallOutcome> {
  try {
    const res = await client.callTool({ name, arguments: args });
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content.map((c) => (c.type === 'text' ? (c.text ?? '') : JSON.stringify(c))).join('\n');
    const meta = (res._meta ?? {}) as Record<string, unknown>;
    const isError = res.isError === true;
    return { text, isError, errorCode: isError ? (errorCodeOf(text) ?? 'TOOL_ERROR') : null, callId: typeof meta[CALL_ID_META] === 'string' ? meta[CALL_ID_META] : null };
  } catch (err) {
    // JSON-RPC errors (unknown tool, forbidden) reach the model as a tool error it can react to
    const data = (err as { data?: { type?: unknown } }).data;
    const code = typeof data?.type === 'string' ? data.type : 'PROTOCOL_ERROR';
    return { text: JSON.stringify({ error: code, message: (err as Error).message }), isError: true, errorCode: code, callId: null };
  }
}

import type Anthropic from '@anthropic-ai/sdk';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CALL_TOOL, callMcpTool, META_TOOLS, type McpTool } from './mcp';
import type { AgentModel } from './model';
import type { CallRecord, Outcome, TurnRecord } from './types';

/** Same for every scenario; the server's `initialize` instructions are appended, as MCP clients do. */
export const SYSTEM_PROMPT = [
  "You are an agent that operates a company's systems through the tools available to you.",
  "Carry out the user's request with those tools. When information is missing, use the tools to find it instead of asking.",
  'Do not ask for confirmation: the user has already approved the request.',
  'If no available tool can carry out the request, say so briefly without calling any tool.',
  'When you are done, reply with a short summary of what you did.',
].join('\n');

/** Caps what a single tool result adds to the context (and to the bill). */
const MAX_RESULT_CHARS = 16_000;

export interface AgentResult {
  turns: TurnRecord[];
  outcome: Outcome;
  error?: string;
}

export function toApiTools(tools: McpTool[]): Anthropic.Tool[] {
  const api = tools.map(
    (t): Anthropic.Tool => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: { ...t.inputSchema, type: 'object' } as Anthropic.Tool.InputSchema,
    }),
  );
  // one breakpoint after the tool list caches tools + system across turns and runs
  const last = api.at(-1);
  if (last) last.cache_control = { type: 'ephemeral' };
  return api;
}

function callRecord(name: string, input: Record<string, unknown>): Pick<CallRecord, 'tool' | 'args' | 'meta'> {
  if (name === CALL_TOOL) {
    const args = input.arguments;
    return { tool: String(input.name ?? ''), args: args && typeof args === 'object' ? (args as Record<string, unknown>) : {}, meta: false };
  }
  return { tool: name, args: input, meta: META_TOOLS.has(name) };
}

const truncate = (s: string) => (s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}\n[truncated]` : s);

export async function runAgent(opts: {
  model: AgentModel;
  mcp: Client;
  tools: Anthropic.Tool[];
  instructions?: string;
  prompt: string;
  maxTurns: number;
}): Promise<AgentResult> {
  const system = opts.instructions ? `${SYSTEM_PROMPT}\n\n${opts.instructions}` : SYSTEM_PROMPT;
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: opts.prompt }];
  const turns: TurnRecord[] = [];
  try {
    for (let i = 0; i < opts.maxTurns; i++) {
      const res = await opts.model.respond({ system, tools: opts.tools, messages });
      // append-only history: the response goes back unchanged, thinking blocks included
      messages.push({ role: 'assistant', content: res.content });
      const turn: TurnRecord = { usage: res.usage, latencyMs: res.latencyMs, stopReason: res.stopReason, calls: [] };
      turns.push(turn);
      if (res.stopReason === 'refusal') return { turns, outcome: 'refusal' };
      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (!uses.length) {
        return res.stopReason === 'end_turn' ? { turns, outcome: 'end_turn' } : { turns, outcome: 'error', error: `stop_reason ${res.stopReason}` };
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      // sequential, so each call's latency is its own
      for (const use of uses) {
        const input = (use.input ?? {}) as Record<string, unknown>;
        const t0 = performance.now();
        const r = await callMcpTool(opts.mcp, use.name, input);
        turn.calls.push({ ...callRecord(use.name, input), isError: r.isError, errorCode: r.errorCode, callId: r.callId, latencyMs: performance.now() - t0 });
        results.push({ type: 'tool_result', tool_use_id: use.id, content: truncate(r.text), ...(r.isError ? { is_error: true } : {}) });
      }
      // all results of a turn in one message
      messages.push({ role: 'user', content: results });
    }
    return { turns, outcome: 'max_turns' };
  } catch (err) {
    return { turns, outcome: 'error', error: (err as Error).message };
  }
}

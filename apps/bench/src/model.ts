import type Anthropic from '@anthropic-ai/sdk';
import { CALL_TOOL } from './mcp';
import type { Task, TokenUsage } from './types';

export interface ModelRequest {
  system: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
}

export interface ModelResponse {
  content: Anthropic.ContentBlock[];
  stopReason: string | null;
  usage: TokenUsage;
  latencyMs: number;
}

export interface AgentModel {
  readonly id: string;
  /** false for the fake model: its runs cost nothing and skip the budget. */
  readonly billed: boolean;
  respond(req: ModelRequest): Promise<ModelResponse>;
  /** Tokens the tool definitions add to a prompt. */
  definitionTokens(tools: Anthropic.Tool[]): Promise<number>;
}

const PROBE: Anthropic.MessageParam[] = [{ role: 'user', content: '.' }];

/**
 * Same settings for every scenario: effort `medium` (the defaults differ between models), adaptive
 * thinking as each model's default, no sampling parameters (non-default values are rejected) and
 * `tool_choice` auto (forced tool use is rejected on Sonnet 5.5).
 */
export function anthropicModel(client: Anthropic, model: string): AgentModel {
  return {
    id: model,
    billed: true,
    async respond({ system, tools, messages }) {
      const t0 = performance.now();
      const res = await client.messages.create({
        model,
        max_tokens: 16_000,
        // breakpoints: after the tools (toApiTools), after the system prompt, and the growing history
        cache_control: { type: 'ephemeral' },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools,
        messages,
        output_config: { effort: 'medium' },
      });
      return {
        content: res.content,
        stopReason: res.stop_reason,
        latencyMs: performance.now() - t0,
        usage: {
          input: res.usage.input_tokens,
          output: res.usage.output_tokens,
          cacheRead: res.usage.cache_read_input_tokens ?? 0,
          cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
        },
      };
    },
    async definitionTokens(tools) {
      if (!tools.length) return 0;
      const [withTools, bare] = await Promise.all([
        client.messages.countTokens({ model, messages: PROBE, tools }),
        client.messages.countTokens({ model, messages: PROBE }),
      ]);
      return withTools.input_tokens - bare.input_tokens;
    },
  };
}

const estimate = (v: unknown) => Math.ceil(JSON.stringify(v).length / 4);

/**
 * Follows the task's answer key, to exercise setup, MCP, scoring and report at no cost.
 * Omni scenarios search first, then go through `call_tool`.
 */
export function fakeModel(task: Task, omni: boolean): AgentModel {
  const steps: Array<{ name: string; input: Record<string, unknown> }> = [];
  if (task.expected.length && omni) steps.push({ name: 'search_tools', input: { query: task.prompt } });
  for (const e of task.expected) {
    steps.push(omni ? { name: CALL_TOOL, input: { name: e.tool, arguments: e.args ?? {} } } : { name: e.tool, input: e.args ?? {} });
  }
  let next = 0;
  return {
    id: 'fake',
    billed: false,
    async respond(req) {
      const step = steps.at(next++);
      const block = step
        ? { type: 'tool_use', id: `toolu_fake_${next}`, name: step.name, input: step.input, caller: { type: 'direct' } }
        : { type: 'text', text: 'done', citations: null };
      return {
        content: [block as unknown as Anthropic.ContentBlock],
        stopReason: step ? 'tool_use' : 'end_turn',
        latencyMs: 0,
        usage: { input: estimate(req), output: estimate(block), cacheRead: 0, cacheWrite: 0 },
      };
    },
    async definitionTokens(tools) {
      return estimate(tools);
    },
  };
}

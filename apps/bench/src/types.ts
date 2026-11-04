export type ScenarioId = 'A' | 'B' | 'C' | 'D';
export type TaskGroup = 'single' | 'multi' | 'ambiguous' | 'none';
export type Outcome = 'end_turn' | 'max_turns' | 'refusal' | 'error';

export interface ExpectedCall {
  tool: string;
  /** Other calls that do the same job (e.g. a list tool and its table view), each with its own arguments. */
  alt?: Array<{ tool: string; args?: Record<string, unknown> }>;
  /** Subset that the actual arguments must contain (strings compared trimmed and case-insensitive). */
  args?: Record<string, unknown>;
}

export interface Task {
  id: string;
  group: TaskGroup;
  prompt: string;
  /** Sent as `mcp-gateway-intent` in scenario D. */
  intent?: string;
  /** Empty for `none`: the right answer is not to call a domain tool. */
  expected: ExpectedCall[];
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CallRecord {
  /** Effective domain tool (for Omni, the `name` inside `call_tool`); the meta-tool name otherwise. */
  tool: string;
  args: Record<string, unknown>;
  /** `search_tools` / `get_tool_schema`: discovery, not a domain call. */
  meta: boolean;
  isError: boolean;
  errorCode: string | null;
  callId: string | null;
  latencyMs: number;
}

export interface TurnRecord {
  usage: TokenUsage;
  latencyMs: number;
  stopReason: string | null;
  calls: CallRecord[];
}

export interface Score {
  /** null for `none` tasks. */
  firstCallCorrect: boolean | null;
  toolSequenceCorrect: boolean;
  success: boolean;
  domainCalls: number;
  metaCalls: number;
  extraCalls: number;
  hallucinated: number;
  validationErrors: number;
  otherErrors: number;
}

export interface RunRecord {
  key: string;
  runId: string;
  phase: 1 | 2;
  scenario: ScenarioId;
  model: string;
  taskId: string;
  group: TaskGroup;
  rep: number;
  pilot: boolean;
  startedAt: string;
  durationMs: number;
  toolCount: number;
  definitionTokens: number | null;
  turns: TurnRecord[];
  outcome: Outcome;
  error?: string;
  costUsd: number;
  costUncachedUsd: number;
  score: Score;
}

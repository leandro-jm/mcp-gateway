import type { NetworkPolicy } from '@mcp-gateway/core';
import type { LlmJsonMode, LlmProvider as LlmProviderName } from '@mcp-gateway/db';

/** One structured-output call: a stable prefix (system + context, cacheable) and the request. */
export interface LlmRequest {
  system: string;
  /** Large, stable block (the tool catalog) sent before the user message. */
  context: string;
  user: string;
  /** JSON Schema the response must follow. */
  schema: Record<string, unknown>;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface LlmResult {
  /** Model output: a JSON object or JSON text (validated by the caller). */
  output: unknown;
  stop: 'end' | 'max_tokens' | 'refusal';
  /** Model that actually answered (may differ after a server-side fallback). */
  model: string;
  usage: LlmUsage;
}

export interface LlmProvider {
  readonly provider: LlmProviderName;
  readonly model: string;
  generate(req: LlmRequest): Promise<LlmResult>;
  /** Cheap authenticated call to check the key and the model (no generation). */
  ping(signal?: AbortSignal): Promise<void>;
}

/** Decrypted tenant configuration needed to build a client (ADR-015). */
export interface LlmClientConfig {
  provider: LlmProviderName;
  model: string;
  baseUrl: string | null;
  apiKey: string;
  jsonMode: LlmJsonMode;
}

export type LlmProviderFactory = (cfg: LlmClientConfig, network: NetworkPolicy) => LlmProvider;

/** Timeout of one provider call; the generation flow has its own overall budget. */
export const LLM_CALL_TIMEOUT_MS = 90_000;

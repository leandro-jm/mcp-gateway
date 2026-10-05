import Anthropic from '@anthropic-ai/sdk';
import type { GatewayError } from '@mcp-gateway/core';
import { llmHttpError, llmTimeoutError, llmTransportError } from './errors';
import { LLM_CALL_TIMEOUT_MS, type LlmClientConfig, type LlmProvider, type LlmRequest, type LlmResult } from './types';

/** Fixed endpoint: the key never goes anywhere else, whatever `ANTHROPIC_BASE_URL` says (ADR-015). */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/** Models that accept the server-side refusal fallback in its `"default"` form. */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-fable-5-1']);
/** Haiku 4.5 rejects `output_config.effort`. */
const supportsEffort = (model: string) => !model.startsWith('claude-haiku');

function mapError(err: unknown): GatewayError {
  if (err instanceof Anthropic.APIConnectionTimeoutError || err instanceof Anthropic.APIUserAbortError) return llmTimeoutError();
  if (err instanceof Anthropic.APIConnectionError) return llmTransportError(err.cause ?? err);
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') return llmHttpError(err.status);
  return llmTransportError(err);
}

export class AnthropicProvider implements LlmProvider {
  readonly provider = 'anthropic' as const;
  readonly model: string;
  private readonly client: Anthropic;

  /** `baseURL` exists only for tests against a local fake; the factory never sets it. */
  constructor(cfg: LlmClientConfig, opts: { baseURL?: string } = {}) {
    this.model = cfg.model;
    this.client = new Anthropic({
      apiKey: cfg.apiKey,
      authToken: null,
      baseURL: opts.baseURL ?? ANTHROPIC_BASE_URL,
      timeout: LLM_CALL_TIMEOUT_MS,
      maxRetries: 1,
    });
  }

  async generate(req: LlmRequest): Promise<LlmResult> {
    const fallback = FALLBACK_MODELS.has(this.model);
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: req.maxTokens,
          // a policy refusal is retried server-side on a model chosen by refusal category
          ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: req.context, cache_control: { type: 'ephemeral' } },
                { type: 'text', text: req.user },
              ],
            },
          ],
          output_config: {
            format: { type: 'json_schema', schema: req.schema },
            ...(supportsEffort(this.model) ? { effort: 'medium' as const } : {}),
          },
        },
        { signal: req.signal },
      );
    } catch (err) {
      throw mapError(err);
    }
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    return {
      output: text,
      stop: res.stop_reason === 'refusal' ? 'refusal' : res.stop_reason === 'max_tokens' ? 'max_tokens' : 'end',
      model: res.model,
      usage: {
        inputTokens: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0),
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      },
    };
  }

  async ping(signal?: AbortSignal): Promise<void> {
    try {
      await this.client.models.retrieve(this.model, {}, { signal, maxRetries: 0, timeout: 15_000 });
    } catch (err) {
      throw mapError(err);
    }
  }
}

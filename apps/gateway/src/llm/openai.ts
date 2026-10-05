import { UpstreamError, ValidationError, type NetworkPolicy } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import { BodyTooLarge, outboundFetch, readLimited } from '@mcp-gateway/net';
import { llmHttpError, llmTransportError } from './errors';
import { LLM_CALL_TIMEOUT_MS, type LlmClientConfig, type LlmProvider, type LlmRequest, type LlmResult } from './types';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

interface ChatCompletion {
  model?: string;
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

/**
 * OpenAI and OpenAI-compatible providers (`POST /chat/completions`). Plain `fetch` through the
 * outbound guard: a custom base URL cannot reach private addresses (SSRF, DNS rebinding) and a
 * redirect cannot carry the key to another host.
 */
export class OpenAiProvider implements LlmProvider {
  readonly provider: 'openai' | 'openai_compatible';
  readonly model: string;
  private readonly baseUrl: string;

  constructor(
    private readonly cfg: LlmClientConfig,
    private readonly network: NetworkPolicy,
  ) {
    this.provider = cfg.provider === 'openai_compatible' ? 'openai_compatible' : 'openai';
    this.model = cfg.model;
    const base = this.provider === 'openai' ? OPENAI_BASE_URL : cfg.baseUrl;
    if (!base) throw new ValidationError(msg('llm.baseUrlRequired'));
    this.baseUrl = base.replace(/\/+$/, '');
  }

  private async call(path: string, init: { method: string; body?: unknown }, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(LLM_CALL_TIMEOUT_MS);
    let res: Response;
    try {
      res = await outboundFetch(
        `${this.baseUrl}${path}`,
        {
          method: init.method,
          headers: { authorization: `Bearer ${this.cfg.apiKey}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
          body: init.body ? JSON.stringify(init.body) : undefined,
          redirect: 'error',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        },
        this.network,
      );
    } catch (err) {
      throw llmTransportError(err);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw llmHttpError(res.status);
    }
    try {
      return JSON.parse((await readLimited(res, MAX_RESPONSE_BYTES)).text);
    } catch (err) {
      if (err instanceof BodyTooLarge || err instanceof SyntaxError) throw new UpstreamError(msg('llm.invalidResponse'));
      throw llmTransportError(err);
    }
  }

  /** Strict `json_schema` when supported; otherwise `json_object` with the schema in the instructions. */
  private responseFormat(schema: Record<string, unknown>) {
    return this.cfg.jsonMode === 'object'
      ? { type: 'json_object' }
      : { type: 'json_schema', json_schema: { name: 'composite_proposal', strict: true, schema } };
  }

  async generate(req: LlmRequest): Promise<LlmResult> {
    const system =
      this.cfg.jsonMode === 'object' ? `${req.system}\n\nRespond with one JSON object matching this JSON Schema:\n${JSON.stringify(req.schema)}` : req.system;
    const body = {
      model: this.model,
      // OpenAI renamed the field; compatible servers still expect the old one
      ...(this.provider === 'openai' ? { max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens }),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `${req.context}\n\n${req.user}` },
      ],
      response_format: this.responseFormat(req.schema),
    };
    const json = (await this.call('/chat/completions', { method: 'POST', body }, req.signal)) as ChatCompletion;
    const choice = json.choices?.[0];
    if (!choice?.message) throw new UpstreamError(msg('llm.invalidResponse'));
    const refused = Boolean(choice.message.refusal) || choice.finish_reason === 'content_filter';
    return {
      output: choice.message.content ?? '',
      stop: refused ? 'refusal' : choice.finish_reason === 'length' ? 'max_tokens' : 'end',
      model: json.model ?? this.model,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        cacheReadTokens: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
    };
  }

  async ping(signal?: AbortSignal): Promise<void> {
    await this.call('/models', { method: 'GET' }, signal);
  }
}

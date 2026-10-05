import type { GatewayError } from '@mcp-gateway/core';
import type { LlmClientConfig, LlmProviderFactory, LlmRequest, LlmResult } from '../src/llm';

type Step = Partial<LlmResult> | GatewayError | ((req: LlmRequest) => Partial<LlmResult>);

/**
 * Scripted LLM for tests: records every client built and every request, and answers each
 * `generate` with the next scripted step (the last one repeats).
 */
export class FakeLlm {
  configs: LlmClientConfig[] = [];
  requests: LlmRequest[] = [];
  pings = 0;
  pingError: GatewayError | undefined;
  private script: Step[] = [];

  answer(...steps: Step[]): this {
    this.script = steps;
    return this;
  }

  reset(): void {
    this.configs = [];
    this.requests = [];
    this.pings = 0;
    this.pingError = undefined;
    this.script = [];
  }

  readonly factory: LlmProviderFactory = (cfg) => {
    this.configs.push(cfg);
    return {
      provider: cfg.provider,
      model: cfg.model,
      generate: async (req) => {
        this.requests.push(req);
        const step = this.script.length > 1 ? this.script.shift()! : this.script[0];
        if (!step) throw new Error('FakeLlm: no scripted answer');
        if (step instanceof Error) throw step;
        const r = typeof step === 'function' ? step(req) : step;
        return { output: '', stop: 'end', model: cfg.model, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 }, ...r };
      },
      ping: async () => {
        this.pings++;
        if (this.pingError) throw this.pingError;
      },
    };
  };
}

import type { GatewayError } from '@mcp-gateway/core';
import type { DecisionAnswer, DecisionRequest, DecisionResponse } from '@mcp-gateway/tool-router';
import type { DecisionClientConfig, DecisionProviderFactory } from '../src/router';

type Answer = DecisionAnswer | ((req: DecisionRequest) => DecisionAnswer | undefined);
type Step = Record<string, Answer> | GatewayError | Error | ((req: DecisionRequest, signal?: AbortSignal) => Promise<DecisionResponse>);

/**
 * Scripted decision provider for tests: records every client built and every request, and
 * answers each `decide` with the next scripted step (the last one repeats). A step maps question
 * names to answers; questions without an entry get no answer.
 */
export class FakeDecisions {
  configs: DecisionClientConfig[] = [];
  requests: DecisionRequest[] = [];
  pings = 0;
  private script: Step[] = [];

  answer(...steps: Step[]): this {
    this.script = steps;
    return this;
  }

  reset(): void {
    this.configs = [];
    this.requests = [];
    this.pings = 0;
    this.script = [];
  }

  /** Fails the test that reaches the provider (router-off checks). */
  forbid(): this {
    return this.answer(() => {
      throw new Error('FakeDecisions: the provider must not be called');
    });
  }

  readonly factory: DecisionProviderFactory = (cfg) => {
    this.configs.push(cfg);
    const decide = async (req: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse> => {
      this.requests.push(req);
      const step = this.script.length > 1 ? this.script.shift()! : this.script[0];
      if (!step) throw new Error('FakeDecisions: no scripted answer');
      if (step instanceof Error) throw step;
      if (typeof step === 'function') return step(req, signal);
      const answers: Record<string, DecisionAnswer> = {};
      for (const q of req.questions) {
        const a = step[q.name];
        const value = typeof a === 'function' ? a(req) : a;
        if (value) answers[q.name] = value;
      }
      return { answers };
    };
    return {
      id: cfg.provider,
      model: cfg.model,
      decide,
      ping: async () => {
        this.pings++;
      },
    };
  };
}

/** Choice answer picking the option whose description mentions `toolName` (option ids are opaque). */
export function chooseTool(toolName: string, confidence = 0.9): (req: DecisionRequest) => DecisionAnswer | undefined {
  return (req) => {
    const q = req.questions.find((x) => x.type === 'choice');
    const option = q?.type === 'choice' ? q.choices.find((c) => c.description.includes(`(${toolName})`) || c.description.startsWith(`${toolName}:`)) : undefined;
    return option ? { type: 'choice', choice: option.value, probabilities: { [option.value]: confidence }, confidence } : { type: 'choice', choice: 'none', probabilities: { none: 1 } };
  };
}

import type { NetworkPolicy } from '@mcp-gateway/core';
import { fromOpenAiDecisionsBody, toOpenAiDecisionsBody, type DecisionProvider, type DecisionRequest, type DecisionResponse } from '@mcp-gateway/tool-router';
import type { DecisionClientConfig } from '../factory';
import { parseWire, postDecision } from './http';

export const OPENAI_DECISIONS_BASE_URL = 'https://api.openai.com/v1';

/** Smallest possible decision: one predicate, used to test the connection. */
export const PING_REQUEST: DecisionRequest = { input: 'ping', questions: [{ name: 'ping', type: 'predicate', instructions: 'Is this a connectivity test?' }] };

/** OpenAI Decisions API (`POST /v1/decisions`, public beta 2026-10). */
export class OpenAiDecisionsProvider implements DecisionProvider {
  readonly id = 'openai_decisions' as const;
  readonly model: string;
  private readonly url: string;

  constructor(
    private readonly cfg: DecisionClientConfig,
    private readonly network: NetworkPolicy,
  ) {
    this.model = cfg.model;
    this.url = `${(cfg.baseUrl ?? OPENAI_DECISIONS_BASE_URL).replace(/\/+$/, '')}/decisions`;
  }

  async decide(req: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse> {
    const json = await postDecision(this.url, toOpenAiDecisionsBody(req, this.model), this.cfg.apiKey, this.network, signal);
    return parseWire(() => fromOpenAiDecisionsBody(json, req));
  }

  async ping(signal?: AbortSignal): Promise<void> {
    await this.decide(PING_REQUEST, signal);
  }
}

import type { NetworkPolicy } from '@mcp-gateway/core';
import { fromJevBody, toJevBody, type DecisionProvider, type DecisionRequest, type DecisionResponse } from '@mcp-gateway/tool-router';
import type { DecisionClientConfig } from '../factory';
import { parseWire, postDecision } from './http';
import { PING_REQUEST } from './openai-decisions';

export const JEV_BASE_URL = 'https://api.typesafe.ai/v1';

/** TypeSafe Jev (`POST /v1/systemone`). Experimental: the wire shape comes from the public docs only (ADR-025). */
export class JevProvider implements DecisionProvider {
  readonly id = 'jev' as const;
  readonly model: string;
  private readonly url: string;

  constructor(
    private readonly cfg: DecisionClientConfig,
    private readonly network: NetworkPolicy,
  ) {
    this.model = cfg.model;
    this.url = `${(cfg.baseUrl ?? JEV_BASE_URL).replace(/\/+$/, '')}/systemone`;
  }

  async decide(req: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse> {
    const json = await postDecision(this.url, toJevBody(req, this.model), this.cfg.apiKey, this.network, signal);
    return parseWire(() => fromJevBody(json, req));
  }

  async ping(signal?: AbortSignal): Promise<void> {
    await this.decide(PING_REQUEST, signal);
  }
}

import type { NetworkPolicy } from '@mcp-gateway/core';
import type { DecisionProvider, DecisionProviderId } from '@mcp-gateway/tool-router';
import { JevProvider } from './providers/jev';
import { OpenAiDecisionsProvider } from './providers/openai-decisions';

export interface DecisionClientConfig {
  provider: DecisionProviderId;
  model: string;
  /** Override of the provider's public URL (proxy, gateway or a test fake). */
  baseUrl: string | null;
  apiKey: string;
}

export type DecisionProviderFactory = (cfg: DecisionClientConfig, network: NetworkPolicy) => DecisionProvider;

export const createDecisionProvider: DecisionProviderFactory = (cfg, network) =>
  cfg.provider === 'jev' ? new JevProvider(cfg, network) : new OpenAiDecisionsProvider(cfg, network);

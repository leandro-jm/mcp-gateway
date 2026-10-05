import { AnthropicProvider } from './anthropic';
import { OpenAiProvider } from './openai';
import type { LlmProviderFactory } from './types';

export const createLlmProvider: LlmProviderFactory = (cfg, network) =>
  cfg.provider === 'anthropic' ? new AnthropicProvider(cfg) : new OpenAiProvider(cfg, network);

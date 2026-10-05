import { effectiveNetworkPolicy, ValidationError, type NetworkPolicy } from '@mcp-gateway/core';
import type { DecryptedLlmSettings } from '@mcp-gateway/db';
import { msg } from '@mcp-gateway/i18n/server';
import type { Services } from '../services';
import type { LlmProvider } from './types';

/** Error code the Admin UI uses to point to the Settings page. */
export const LLM_NOT_CONFIGURED = 'LLM_NOT_CONFIGURED';

/** Network policy for calls to the tenant's LLM provider: same rules as the upstreams. */
export async function llmNetworkPolicy(services: Services, tenantId: string): Promise<NetworkPolicy> {
  const tenant = await services.repos.tenants.get(tenantId);
  return effectiveNetworkPolicy(services.config.NETWORK_ALLOW_PRIVATE, tenant.settings);
}

/** Builds the tenant's LLM client from its stored configuration (ADR-015). */
export async function tenantLlm(services: Services, tenantId: string): Promise<{ settings: DecryptedLlmSettings; provider: LlmProvider }> {
  const settings = await services.repos.llmSettings.getDecrypted(tenantId);
  if (!settings) throw new ValidationError(msg('llm.notConfigured'), { code: LLM_NOT_CONFIGURED });
  if (!settings.apiKey) throw new ValidationError(msg('llm.noApiKey'), { code: LLM_NOT_CONFIGURED });
  const provider = services.llm(
    { provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl, apiKey: settings.apiKey, jsonMode: settings.jsonMode },
    await llmNetworkPolicy(services, tenantId),
  );
  return { settings, provider };
}

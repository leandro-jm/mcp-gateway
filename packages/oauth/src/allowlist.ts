/**
 * Tenant client allowlist (ADR-030, `settings.oauth.allowlist`). An entry is either an exact
 * `client_id` (a CIMD URL or a DCR identifier) or a bare host, which admits every CIMD client
 * served by that host (`claude.ai`). Hosts never match DCR clients: their identity is self-declared.
 */
import { isClientMetadataUrl } from './client-metadata';

export interface AllowlistClient {
  clientId: string;
  kind: 'cimd' | 'dcr';
}

const HOST = /^[a-z0-9.-]+(?::\d{1,5})?$/;

export function isAllowlistHost(entry: string): boolean {
  return HOST.test(entry);
}

export function clientInAllowlist(allowlist: readonly string[], client: AllowlistClient): boolean {
  if (allowlist.includes(client.clientId)) return true;
  if (client.kind !== 'cimd' || !isClientMetadataUrl(client.clientId)) return false;
  const host = new URL(client.clientId).host;
  return allowlist.some((entry) => {
    const candidate = entry.toLowerCase();
    return isAllowlistHost(candidate) && candidate === host;
  });
}

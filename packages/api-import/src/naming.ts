import { snake } from '@mcp-gateway/openapi-toolgen';

const GENERIC_HOST_LABELS = new Set(['www', 'api', 'apis', 'app', 'gateway', 'rest', 'v1', 'v2', 'dev', 'staging', 'sandbox', 'prod']);
const MAX_SOURCE_NAME = 32;

/**
 * Source name (`^[a-z][a-z0-9_]{0,31}$`) from a title or a hostname: `api.acme.com.br` → `acme`,
 * `RH Público API` → `rh_publico_api`, `127.0.0.1` → `api`.
 */
export function suggestName(titleOrHost: string): string {
  let base = titleOrHost;
  if (/^[a-z0-9.-]+$/i.test(titleOrHost) && titleOrHost.includes('.')) {
    if (/^[\d.]+$/.test(titleOrHost)) return 'api';
    const labels = titleOrHost.toLowerCase().split('.');
    base = labels.find((l, i) => i < labels.length - 1 && !GENERIC_HOST_LABELS.has(l)) ?? labels[0]!;
  }
  let name = snake(base).replace(/^[^a-z]+/, '');
  if (!name) name = 'api';
  return name.slice(0, MAX_SOURCE_NAME).replace(/_+$/, '');
}

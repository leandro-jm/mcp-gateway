/**
 * Resource indicators (RFC 8707). A token is issued for the gateway itself (`PUBLIC_URL`, the
 * resource of the root Protected Resource Metadata) or for one of its MCP surfaces; any other
 * value is `invalid_target`. Tokens are valid on every surface (ADR-030), but the resource is still
 * checked so a token minted for another server is never accepted here.
 */

/** MCP surfaces relative to the public base path; slugs follow the virtual server rule. */
const MCP_PATH = /^\/mcp(?:\/omni|\/observability|\/s\/[a-z0-9][a-z0-9-]{1,62}(?:\/omni)?)?$/;

/** The issuer and resource base: `PUBLIC_URL` without a trailing slash. */
export function issuerOf(publicUrl: string): string {
  const url = new URL(publicUrl);
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** Canonical form of an MCP resource of this gateway, or `undefined` if it is not one. */
export function canonicalMcpResource(raw: string, publicUrl: string): string | undefined {
  if (raw.length === 0 || raw.length > 2048 || raw.includes('#')) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.search) return undefined;
  const base = new URL(issuerOf(publicUrl));
  if (url.origin !== base.origin) return undefined;
  const basePath = base.pathname === '/' ? '' : base.pathname;
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  if (path === basePath || path === `${basePath}/`) return issuerOf(publicUrl);
  if (!path.startsWith(`${basePath}/`)) return undefined;
  const rest = path.slice(basePath.length);
  return MCP_PATH.test(rest) ? `${url.origin}${path}` : undefined;
}

/** Resource assumed when a client omits `resource` (clients older than spec 2025-06-18): the gateway itself. */
export function defaultMcpResource(publicUrl: string): string {
  return issuerOf(publicUrl);
}

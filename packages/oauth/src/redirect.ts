/**
 * Redirect URI rules. Registration accepts HTTPS anywhere, plain HTTP only on loopback, and
 * private-use schemes (`cursor://…`) only for native clients (RFC 8252 §7.1). Matching is an exact
 * string comparison, except that a loopback redirect may use any port (RFC 8252 §7.3).
 */

export type ApplicationType = 'web' | 'native';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** Schemes that can run code or read local data in the browser; never valid redirects. */
const FORBIDDEN_SCHEMES = new Set([
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
  'about:',
  'blob:',
  'filesystem:',
  'ftp:',
  'ws:',
  'wss:',
]);

export const MAX_REDIRECT_URI_LENGTH = 2048;

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function parse(raw: string): URL | undefined {
  if (raw.length === 0 || raw.length > MAX_REDIRECT_URI_LENGTH || raw.includes('#')) return undefined;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/** True when the URL points at the local machine (any scheme other than HTTPS needs this or a native client). */
export function isLoopbackRedirect(raw: string): boolean {
  const url = parse(raw);
  return !!url && (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHost(url.hostname);
}

/** Whether a redirect URI may be registered for a client of the given type. */
export function isAcceptableRedirectUri(raw: string, applicationType: ApplicationType): boolean {
  const url = parse(raw);
  if (!url || url.username || url.password) return false;
  if (url.protocol === 'https:') return url.hostname.length > 0;
  if (url.protocol === 'http:') return isLoopbackHost(url.hostname) && applicationType === 'native';
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return false;
  return applicationType === 'native';
}

/**
 * The type a client gets when it does not declare one: `native` when every redirect stays on the
 * device (loopback or private-use scheme), `web` otherwise.
 */
export function inferApplicationType(redirectUris: readonly string[]): ApplicationType {
  const local = redirectUris.every((raw) => {
    const url = parse(raw);
    if (!url) return false;
    if (url.protocol === 'https:') return isLoopbackHost(url.hostname);
    if (url.protocol === 'http:') return isLoopbackHost(url.hostname);
    return !FORBIDDEN_SCHEMES.has(url.protocol);
  });
  return local ? 'native' : 'web';
}

/** Whether the redirect URI sent in a request matches one of the registered ones. */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  const want = parse(requested);
  if (!want || (want.protocol !== 'http:' && want.protocol !== 'https:') || !isLoopbackHost(want.hostname)) {
    return false;
  }
  return registered.some((raw) => {
    const have = parse(raw);
    return (
      !!have &&
      have.protocol === want.protocol &&
      have.hostname.toLowerCase() === want.hostname.toLowerCase() &&
      have.pathname === want.pathname &&
      have.search === want.search
    );
  });
}

/** Appends response parameters to a validated redirect URI, keeping its own query (RFC 6749 §3.1.2). */
export function buildRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

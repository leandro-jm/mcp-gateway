/**
 * Keys that must never appear in plaintext in logs. Used by the apps' logger (pino `redact`)
 * and by payload sanitizers.
 */
export const SENSITIVE_KEYS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'password',
  'secret',
  'client_secret',
  'clientSecret',
  'access_token',
  'refresh_token',
  'token',
  'apiKey',
  'api_key',
  'config',
  'config_encrypted',
  'masterKey',
] as const;

const SENSITIVE_SET = new Set(SENSITIVE_KEYS.map((k) => k.toLowerCase()));

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_SET.has(key.toLowerCase());
}

/**
 * Request bodies that carry personal data on purpose: the LGPD subject lookup sends the
 * identifier in `value` (ADR-017).
 */
const PII_BODY_PATHS = ['body.value', 'req.body.value', '*.body.value'];

/** Paths in pino `redact` format (up to 2 levels deep). */
export const LOG_REDACT_PATHS: string[] = [
  ...SENSITIVE_KEYS.flatMap((k) => {
    const p = /^[a-zA-Z_]\w*$/.test(k) ? k : `["${k}"]`;
    const join = (prefix: string) => (p.startsWith('[') ? `${prefix}${p}` : `${prefix}.${p}`);
    return [p, join('*'), join('req.headers'), join('*.*')];
  }),
  ...PII_BODY_PATHS,
];

/** Recursively removes values of sensitive keys. */
export function scrubSensitive<T>(value: T): T {
  if (Array.isArray(value)) return value.map(scrubSensitive) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, isSensitiveKey(k) ? '[REDACTED]' : scrubSensitive(v)]),
    ) as T;
  }
  return value;
}

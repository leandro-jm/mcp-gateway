import { verifyPassword } from '@mcp-gateway/core';
import type { LoginRecord } from '@mcp-gateway/db';
import type { Services } from '../services';

/**
 * Reference hash for unknown usernames: verification takes the same time,
 * without revealing which usernames exist.
 */
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/**
 * Password login shared by the Admin UI and the OAuth login page (ADR-011, ADR-030): rate limits
 * per username + IP and per username (throws `RateLimited`), a constant-time check and the status
 * checks. Returns `undefined` for any failure, so callers answer with one generic message.
 */
export async function checkPasswordLogin(
  services: Pick<Services, 'config' | 'rateLimiter' | 'repos'>,
  ip: string,
  username: string,
  password: string,
): Promise<LoginRecord | undefined> {
  const user = username.toLowerCase();
  await services.rateLimiter.check([
    { scope: 'login', key: `login:${user}:${ip}`, limit: { limit: services.config.AUTH_LOGIN_RATE_LIMIT, windowSec: 300 } },
    // the IP may come from a header: a per-user ceiling bounds guessing from many addresses
    { scope: 'login', key: `login-user:${user}`, limit: { limit: services.config.AUTH_LOGIN_USER_RATE_LIMIT, windowSec: 900 } },
  ]);
  const rec = await services.repos.auth.findLogin(username);
  const ok = await verifyPassword(password, rec?.passwordHash ?? DUMMY_HASH);
  if (!rec || !ok || rec.user.kind !== 'human' || rec.user.status !== 'active') return undefined;
  if (rec.tenant && rec.tenant.status !== 'active') return undefined;
  return rec;
}

import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Built-in authentication primitives (ADR-011): password hashing (scrypt) and opaque tokens.
 * Only the token hash is persisted; the plaintext value is shown once, at creation.
 */

export const API_TOKEN_PREFIX = 'mgw_';

const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 32 } as const;

function scryptAsync(password: string, salt: Buffer, keyLen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

/** Format: `scrypt$N$r$p$<salt base64url>$<hash base64url>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p, keyLen } = SCRYPT;
  const hash = await scryptAsync(password, salt, keyLen, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const got = await scryptAsync(password, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export interface GeneratedToken {
  /** Plaintext value (shown only once). */
  token: string;
  /** Start of the token, to identify it in listings. */
  prefix: string;
  hash: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateApiToken(): GeneratedToken {
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, prefix: token.slice(0, API_TOKEN_PREFIX.length + 6), hash: hashToken(token) };
}

/** Random password (admin bootstrap). */
export function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

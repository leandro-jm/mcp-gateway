import { describe, expect, it } from 'vitest';
import { API_TOKEN_PREFIX, generateApiToken, generatePassword, hashPassword, hashToken, verifyPassword } from './auth';

describe('passwords', () => {
  it('hashes with salted scrypt and verifies', async () => {
    const h = await hashPassword('s3cret');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(h).not.toContain('s3cret');
    expect(await verifyPassword('s3cret', h)).toBe(true);
    expect(await verifyPassword('other', h)).toBe(false);
  });

  it('the same text produces different hashes', async () => {
    expect(await hashPassword('x')).not.toBe(await hashPassword('x'));
  });

  it('an invalid format does not verify', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$1$2$3$a$b')).toBe(false);
  });

  it('generates a random password', () => {
    expect(generatePassword()).toHaveLength(24);
    expect(generatePassword()).not.toBe(generatePassword());
  });
});

describe('opaque tokens', () => {
  it('generates a token with prefix, display prefix and sha256 hash', () => {
    const t = generateApiToken();
    expect(t.token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(t.token.length).toBeGreaterThan(40);
    expect(t.token.startsWith(t.prefix)).toBe(true);
    expect(t.hash).toBe(hashToken(t.token));
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(generateApiToken().token).not.toBe(t.token);
  });
});

import { describe, expect, it } from 'vitest';
import { decrypt, decryptJson, encrypt, encryptJson, generateDataKey, unwrapDataKey, wrapDataKey } from './crypto';

describe('envelope encryption', () => {
  const master = generateDataKey();

  it('encrypts and decrypts with AAD', () => {
    const key = generateDataKey();
    const ct = encrypt(key, 'secret', 'ctx');
    expect(ct.startsWith('v1.')).toBe(true);
    expect(ct).not.toContain('secret');
    expect(decrypt(key, ct, 'ctx').toString()).toBe('secret');
  });

  it('uses a random IV (the same text produces different ciphertexts)', () => {
    const key = generateDataKey();
    expect(encrypt(key, 'x')).not.toBe(encrypt(key, 'x'));
  });

  it('fails with a different AAD, wrong key or tampered ciphertext', () => {
    const key = generateDataKey();
    const ct = encrypt(key, 'secret', 'a');
    expect(() => decrypt(key, ct, 'b')).toThrow();
    expect(() => decrypt(generateDataKey(), ct, 'a')).toThrow();
    const parts = ct.split('.');
    parts[3] = Buffer.from('something else').toString('base64url');
    expect(() => decrypt(key, parts.join('.'), 'a')).toThrow();
  });

  it('the tenant data key is bound to the tenant', () => {
    const dk = generateDataKey();
    const wrapped = wrapDataKey(master, dk, 't1');
    expect(unwrapDataKey(master, wrapped, 't1').equals(dk)).toBe(true);
    expect(() => unwrapDataKey(master, wrapped, 't2')).toThrow();
  });

  it('roundtrip JSON', () => {
    const key = generateDataKey();
    expect(decryptJson(key, encryptJson(key, { a: 1 }))).toEqual({ a: 1 });
  });
});

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption with AES-256-GCM.
 *
 * - The master key (env `GATEWAY_MASTER_KEY`) encrypts one data key per tenant.
 * - The tenant's data key encrypts the credentials.
 *
 * Ciphertext format: `v1.<iv>.<tag>.<ciphertext>` (base64url). The AAD binds the
 * ciphertext to its context (e.g. tenant and credential), preventing swaps between records.
 */

const VERSION = 'v1';
const IV_BYTES = 12;

export function generateDataKey(): Buffer {
  return randomBytes(32);
}

export function decodeKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new Error('key must be 32 bytes');
  return key;
}

export function encrypt(key: Buffer, plaintext: Buffer | string, aad?: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(key: Buffer, payload: string, aad?: string): Buffer {
  const [version, iv, tag, ct] = payload.split('.');
  if (version !== VERSION || !iv || !tag || ct === undefined) throw new Error('invalid ciphertext format');
  // a fixed tag length: otherwise a truncated (weaker) tag would be accepted
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
}

/** Encrypts a tenant's data key with the master key. */
export function wrapDataKey(masterKey: Buffer, dataKey: Buffer, tenantId: string): string {
  return encrypt(masterKey, dataKey, `tenant-key:${tenantId}`);
}

export function unwrapDataKey(masterKey: Buffer, wrapped: string, tenantId: string): Buffer {
  return decrypt(masterKey, wrapped, `tenant-key:${tenantId}`);
}

export function encryptJson(key: Buffer, value: unknown, aad?: string): string {
  return encrypt(key, JSON.stringify(value), aad);
}

export function decryptJson<T>(key: Buffer, payload: string, aad?: string): T {
  return JSON.parse(decrypt(key, payload, aad).toString('utf8')) as T;
}

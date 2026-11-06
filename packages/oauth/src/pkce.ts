import { createHash, timingSafeEqual } from 'node:crypto';

/** RFC 7636 §4.1: 43 to 128 characters from the unreserved set. */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
/** base64url of a SHA-256 digest, without padding. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export function isValidCodeVerifier(verifier: string): boolean {
  return VERIFIER.test(verifier);
}

export function isValidCodeChallenge(challenge: string): boolean {
  return CHALLENGE.test(challenge);
}

/** `BASE64URL(SHA256(ASCII(code_verifier)))` (RFC 7636 §4.2). */
export function s256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** Checks a verifier against the stored `S256` challenge in constant time. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!isValidCodeVerifier(verifier) || !isValidCodeChallenge(challenge)) return false;
  const expected = Buffer.from(s256Challenge(verifier), 'ascii');
  const given = Buffer.from(challenge, 'ascii');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

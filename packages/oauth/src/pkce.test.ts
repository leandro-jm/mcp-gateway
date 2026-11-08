import { describe, expect, it } from 'vitest';
import { isValidCodeChallenge, isValidCodeVerifier, s256Challenge, verifyPkceS256 } from './pkce';

// RFC 7636 Appendix B.
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('pkce', () => {
  it('computes the RFC 7636 S256 vector', () => {
    expect(s256Challenge(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
  });

  it('accepts the matching verifier', () => {
    expect(verifyPkceS256(RFC_VERIFIER, RFC_CHALLENGE)).toBe(true);
  });

  it('rejects a different verifier', () => {
    expect(verifyPkceS256(`${RFC_VERIFIER.slice(0, -1)}x`, RFC_CHALLENGE)).toBe(false);
  });

  it('rejects the plain method (verifier equal to the challenge)', () => {
    expect(verifyPkceS256(RFC_CHALLENGE, RFC_CHALLENGE)).toBe(false);
  });

  it('enforces the verifier length and alphabet', () => {
    expect(isValidCodeVerifier('a'.repeat(42))).toBe(false);
    expect(isValidCodeVerifier('a'.repeat(43))).toBe(true);
    expect(isValidCodeVerifier('a'.repeat(128))).toBe(true);
    expect(isValidCodeVerifier('a'.repeat(129))).toBe(false);
    expect(isValidCodeVerifier(`${'a'.repeat(42)}+`)).toBe(false);
    expect(verifyPkceS256('short', RFC_CHALLENGE)).toBe(false);
  });

  it('enforces the challenge shape', () => {
    expect(isValidCodeChallenge(RFC_CHALLENGE)).toBe(true);
    expect(isValidCodeChallenge(`${RFC_CHALLENGE}=`)).toBe(false);
    expect(isValidCodeChallenge(RFC_CHALLENGE.slice(1))).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { clientInAllowlist, isAllowlistHost } from './allowlist';
import { OAUTH_ERROR_REASONS } from './errors';

describe('clientInAllowlist', () => {
  const claude = { clientId: 'https://claude.ai/oauth/meta', kind: 'cimd' as const };

  it('matches an exact client_id', () => {
    expect(clientInAllowlist([claude.clientId], claude)).toBe(true);
    expect(clientInAllowlist(['dcr_abc'], { clientId: 'dcr_abc', kind: 'dcr' })).toBe(true);
  });

  it('matches every CIMD client of a host', () => {
    expect(clientInAllowlist(['claude.ai'], claude)).toBe(true);
    expect(clientInAllowlist(['CLAUDE.AI'], claude)).toBe(true);
    expect(clientInAllowlist(['claude.ai'], { clientId: 'https://evil.ai/claude.ai', kind: 'cimd' })).toBe(false);
    expect(clientInAllowlist(['ai'], claude)).toBe(false);
  });

  it('never matches DCR clients by host', () => {
    expect(clientInAllowlist(['claude.ai'], { clientId: 'claude.ai', kind: 'dcr' })).toBe(true);
    expect(clientInAllowlist(['claude.ai'], { clientId: 'https://claude.ai/oauth/meta', kind: 'dcr' })).toBe(false);
  });

  it('admits nothing with an empty list', () => {
    expect(clientInAllowlist([], claude)).toBe(false);
  });

  it('recognizes host entries', () => {
    expect(isAllowlistHost('claude.ai')).toBe(true);
    expect(isAllowlistHost('localhost:8443')).toBe(true);
    expect(isAllowlistHost('https://claude.ai/x')).toBe(false);
  });
});

describe('error reasons', () => {
  it('are unique', () => {
    expect(new Set(OAUTH_ERROR_REASONS).size).toBe(OAUTH_ERROR_REASONS.length);
  });
});

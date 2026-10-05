import { hashToken } from '@mcp-gateway/core';
import type { AuthQueries, TokenRecord } from '@mcp-gateway/db';
import { describe, expect, it } from 'vitest';
import { bearerToken, TokenVerifier } from '../src/auth/tokens';

const now0 = new Date('2026-10-03T12:00:00Z').getTime();

function record(over: { expiresAt?: Date | null; revokedAt?: Date | null; status?: 'active' | 'disabled'; tenant?: TokenRecord['tenant']; selfIssued?: boolean } = {}): TokenRecord {
  const at = new Date(now0);
  return {
    token: { id: 't1', userId: 'u1', name: 'ponto-bot', kind: 'api', selfIssued: over.selfIssued ?? false, prefix: 'mgw_abc', expiresAt: over.expiresAt ?? null, lastUsedAt: null, revokedAt: over.revokedAt ?? null, createdAt: at },
    user: {
      id: 'u1',
      tenantId: 'tid',
      username: 'bot',
      displayName: 'Bot',
      kind: 'service',
      roles: ['agent'],
      groups: ['team-rh'],
      attributes: { unidades: ['u1'] },
      status: over.status ?? 'active',
      locale: 'pt-BR',
      hasPassword: false,
      createdAt: at,
      updatedAt: at,
    },
    tenant: over.tenant === undefined ? { id: 'tid', slug: 'acme', status: 'active' } : over.tenant,
  };
}

function fakeAuth(rec: TokenRecord | undefined) {
  const calls = { find: 0, touch: 0 };
  const auth = {
    findToken: async (hash: string) => {
      calls.find++;
      return hash === hashToken('mgw_ok') ? rec : undefined;
    },
    touchToken: async () => void calls.touch++,
  } as unknown as AuthQueries;
  return { auth, calls };
}

describe('TokenVerifier (ADR-011)', () => {
  it('builds the principal from the user and the token', async () => {
    const { auth } = fakeAuth(record());
    const p = await new TokenVerifier(auth, { now: () => now0 }).verify('mgw_ok');
    expect(p).toMatchObject({ sub: 'bot', tenant: 'acme', roles: ['agent'], groups: ['team-rh'], clientId: 'ponto-bot', locale: 'pt-BR', userId: 'u1', tokenId: 't1' });
    expect(p.claims).toMatchObject({ unidades: ['u1'], name: 'Bot', preferred_username: 'bot' });
  });

  it('a self-issued token cannot take an admin-issued clientId', async () => {
    const { auth } = fakeAuth(record({ selfIssued: true }));
    expect(await new TokenVerifier(auth, { now: () => now0 }).verify('mgw_ok')).toMatchObject({ clientId: 'me/ponto-bot', kind: 'service' });
  });

  it('platform admins have no tenant', async () => {
    const { auth } = fakeAuth(record({ tenant: null }));
    expect((await new TokenVerifier(auth, { now: () => now0 }).verify('mgw_ok')).tenant).toBeUndefined();
  });

  it.each([
    ['unknown', undefined, 'mgw_x', 'auth.invalidToken', 'invalid token'],
    ['expired', record({ expiresAt: new Date(now0 - 1) }), 'mgw_ok', 'auth.expiredToken', 'token expired'],
    ['revoked', record({ revokedAt: new Date(now0 - 1) }), 'mgw_ok', 'auth.revokedToken', 'token revoked'],
    ['of a disabled user', record({ status: 'disabled' }), 'mgw_ok', 'auth.userDisabled', 'user disabled'],
    ['of a suspended tenant', record({ tenant: { id: 'tid', slug: 'acme', status: 'suspended' } }), 'mgw_ok', 'auth.tenantInactive', 'tenant acme is suspended'],
  ] as const)('rejects a token that is %s', async (_l, rec, token, key, message) => {
    const { auth } = fakeAuth(rec);
    await expect(new TokenVerifier(auth, { now: () => now0 }).verify(token)).rejects.toMatchObject({ message, msg: { key } });
  });

  it('caches within the TTL, negatives included; forget and clear drop entries', async () => {
    let now = now0;
    const { auth, calls } = fakeAuth(record());
    const v = new TokenVerifier(auth, { cacheTtlMs: 1000, now: () => now });
    await v.verify('mgw_ok');
    await v.verify('mgw_ok');
    await expect(v.verify('mgw_x')).rejects.toThrow();
    await expect(v.verify('mgw_x')).rejects.toThrow();
    expect(calls.find).toBe(2);
    now += 1001;
    await v.verify('mgw_ok');
    expect(calls.find).toBe(3);
    v.forget(hashToken('mgw_ok'));
    await v.verify('mgw_ok');
    v.clear();
    await v.verify('mgw_ok');
    expect(calls.find).toBe(5);
  });

  it('expiry applies even with the record cached', async () => {
    let now = now0;
    const { auth } = fakeAuth(record({ expiresAt: new Date(now0 + 500) }));
    const v = new TokenVerifier(auth, { cacheTtlMs: 10_000, now: () => now });
    await v.verify('mgw_ok');
    now += 600;
    await expect(v.verify('mgw_ok')).rejects.toMatchObject({ message: 'token expired' });
  });

  it('updates last_used_at at most once per interval', async () => {
    let now = now0;
    const { auth, calls } = fakeAuth(record());
    const v = new TokenVerifier(auth, { touchIntervalMs: 60_000, now: () => now });
    await v.verify('mgw_ok');
    await v.verify('mgw_ok');
    expect(calls.touch).toBe(1);
    now += 60_000;
    await v.verify('mgw_ok');
    expect(calls.touch).toBe(2);
  });

  it('extracts the Bearer from the header', () => {
    expect(bearerToken('Bearer mgw_x ')).toBe('mgw_x');
    expect(bearerToken('bearer mgw_x')).toBe('mgw_x');
    expect(bearerToken('Basic abc')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});

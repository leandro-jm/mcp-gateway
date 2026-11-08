import { hashToken } from '@mcp-gateway/core';
import type { AuthQueries, TokenRecord } from '@mcp-gateway/db';
import { describe, expect, it } from 'vitest';
import { bearerToken, TokenVerifier, wwwAuthenticate } from '../src/auth/tokens';

const now0 = new Date('2026-10-03T12:00:00Z').getTime();

function record(over: { expiresAt?: Date | null; revokedAt?: Date | null; status?: 'active' | 'disabled'; tenant?: TokenRecord['tenant']; selfIssued?: boolean } = {}): TokenRecord {
  const at = new Date(now0);
  return {
    token: { id: 't1', userId: 'u1', name: 'ponto-bot', kind: 'api', selfIssued: over.selfIssued ?? false, prefix: 'mgw_abc', expiresAt: over.expiresAt ?? null, lastUsedAt: null, revokedAt: over.revokedAt ?? null, grantId: null, createdAt: at },
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

describe('TokenVerifier with OAuth tokens (F20.5, ADR-030)', () => {
  type OAuthOver = Partial<NonNullable<TokenRecord['oauth']>> & { userKind?: 'human' | 'service' };
  function oauthRecord(over: OAuthOver = {}): TokenRecord {
    const { userKind = 'human', ...oauth } = over;
    const base = record();
    return {
      ...base,
      token: { ...base.token, kind: 'oauth', name: 'oauth', grantId: 'g1' },
      user: { ...base.user, kind: userKind },
      oauth: {
        grantId: 'g1',
        grantRevokedAt: null,
        scopes: ['mcp', 'offline_access'],
        resource: 'https://gw.example/mcp',
        clientId: 'https://claude.ai/oauth/meta',
        clientKind: 'cimd',
        clientDisabledAt: null,
        tenantSettings: { enabled: true, clients: 'any' },
        ...oauth,
      },
    };
  }
  const verifier = (rec: TokenRecord, oauthEnabled = true) => new TokenVerifier(fakeAuth(rec).auth, { now: () => now0, oauthEnabled });

  it('identifies the connected app by its verifiable host and keeps the scopes', async () => {
    const p = await verifier(oauthRecord()).verify('mgw_ok');
    expect(p).toMatchObject({ sub: 'bot', clientId: 'oauth:claude.ai', tokenKind: 'oauth', scopes: ['mcp', 'offline_access'] });
  });

  it('names DCR clients by their generated id, never by a self-declared name', async () => {
    const p = await verifier(oauthRecord({ clientId: 'dcr_abc', clientKind: 'dcr' })).verify('mgw_ok');
    expect(p.clientId).toBe('oauth:dcr:dcr_abc');
  });

  it('accepts a client listed in the tenant allowlist', async () => {
    const rec = oauthRecord({ tenantSettings: { enabled: true, allowlist: ['claude.ai'] } });
    expect((await verifier(rec).verify('mgw_ok')).clientId).toBe('oauth:claude.ai');
  });

  it.each([
    ['the platform switch is off', oauthRecord(), false, 'auth.oauthPlatformDisabled'],
    ['the grant was revoked', oauthRecord({ grantRevokedAt: new Date(now0 - 1) }), true, 'auth.revokedToken'],
    ['the client was disabled', oauthRecord({ clientDisabledAt: new Date(now0 - 1) }), true, 'oauth.reason.client_disabled'],
    ['the owner is a service user', oauthRecord({ userKind: 'service' }), true, 'oauth.reason.user_not_allowed'],
    ['the tenant turned OAuth off', oauthRecord({ tenantSettings: { enabled: false } }), true, 'oauth.reason.tenant_oauth_disabled'],
    ['the tenant settings are invalid', oauthRecord({ tenantSettings: { enabled: 'yes' } }), true, 'oauth.reason.tenant_oauth_disabled'],
    ['the client left the allowlist', oauthRecord({ tenantSettings: { enabled: true, allowlist: ['chatgpt.com'] } }), true, 'oauth.reason.client_not_allowed'],
  ] as const)('rejects the token when %s', async (_l, rec, enabled, key) => {
    await expect(verifier(rec, enabled).verify('mgw_ok')).rejects.toMatchObject({ msg: { key } });
  });

  it('rejects an oauth token whose grant is missing', async () => {
    const { oauth: _o, ...rec } = oauthRecord();
    await expect(verifier(rec).verify('mgw_ok')).rejects.toMatchObject({ msg: { key: 'auth.revokedToken' } });
  });

  it('other token kinds have no scopes', async () => {
    expect(await new TokenVerifier(fakeAuth(record()).auth, { now: () => now0 }).verify('mgw_ok')).toMatchObject({ tokenKind: 'api', scopes: [] });
  });
});

describe('wwwAuthenticate', () => {
  it('keeps the plain challenge without OAuth', () => {
    expect(wwwAuthenticate()).toBe('Bearer realm="mcp-gateway"');
    expect(wwwAuthenticate('invalid_token', 'token "revoked"')).toBe(`Bearer realm="mcp-gateway", error="invalid_token", error_description="token 'revoked'"`);
  });

  it('announces the protected resource metadata and the scope', () => {
    expect(wwwAuthenticate(undefined, undefined, { resource: 'https://gw.example/mcp/omni', scope: 'mcp' })).toBe(
      'Bearer realm="mcp-gateway", resource_metadata="https://gw.example/.well-known/oauth-protected-resource/mcp/omni", scope="mcp"',
    );
  });
});

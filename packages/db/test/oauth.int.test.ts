import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthQueries, OAuthGrantsRepo, OAuthQueries, tenants, users } from '../src';
import { setupTestDb, type TestDb } from './helpers';

const HOUR = 3_600_000;

describe('oauth persistence (F20.3)', () => {
  let t: TestDb;
  let q: OAuthQueries;
  let grantsRepo: OAuthGrantsRepo;
  let auth: AuthQueries;
  let tenantA: string;
  let tenantB: string;
  let alice: string;
  let bob: string;
  let carol: string;

  beforeAll(async () => {
    t = await setupTestDb();
    q = new OAuthQueries(t.db);
    grantsRepo = new OAuthGrantsRepo(t.db);
    auth = new AuthQueries(t.db);
    const ts = await t.db
      .insert(tenants)
      .values([
        { slug: 'a', name: 'A' },
        { slug: 'b', name: 'B' },
      ])
      .returning();
    tenantA = ts[0]!.id;
    tenantB = ts[1]!.id;
    const us = await t.db
      .insert(users)
      .values([
        { tenantId: tenantA, username: 'alice' },
        { tenantId: tenantA, username: 'bob' },
        { tenantId: tenantB, username: 'carol' },
      ])
      .returning();
    alice = us[0]!.id;
    bob = us[1]!.id;
    carol = us[2]!.id;
  });
  afterAll(async () => t?.teardown());

  const cimd = (name = 'Claude') => ({
    clientId: 'https://claude.ai/oauth/meta',
    clientName: name,
    redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    applicationType: 'web' as const,
  });

  async function newClient(suffix: string) {
    return q.createDcrClient({
      clientId: `dcr_${suffix}`,
      clientName: `CLI ${suffix}`,
      redirectUris: ['http://127.0.0.1/callback'],
      applicationType: 'native',
    });
  }

  async function accessToken(userId: string, grantId: string, hash: string) {
    return auth.createToken(userId, { name: 'oauth', kind: 'oauth', tokenHash: hash, prefix: 'mgw_x', grantId });
  }

  describe('clients', () => {
    it('upserts CIMD metadata without duplicating the client', async () => {
      const first = await q.upsertCimdClient(cimd('Claude'));
      const again = await q.upsertCimdClient({ ...cimd('Claude.ai'), redirectUris: ['https://claude.ai/cb2'] });
      expect(again.id).toBe(first.id);
      expect(again).toMatchObject({ kind: 'cimd', clientName: 'Claude.ai', redirectUris: ['https://claude.ai/cb2'] });
      expect(again.fetchedAt).toBeInstanceOf(Date);
      expect((await q.findClient(cimd().clientId))?.id).toBe(first.id);
    });

    it('creates DCR clients and lists them with their active grants', async () => {
      const dcr = await newClient('list');
      await q.saveGrant({ tenantId: tenantA, userId: alice, clientId: dcr.id, scopes: ['mcp'], resource: 'https://gw/mcp' });
      const page = await q.listClients({ kind: 'dcr' });
      expect(page.items.find((c) => c.id === dcr.id)).toMatchObject({ kind: 'dcr', activeGrants: 1 });
      expect(page.items.every((c) => c.kind === 'dcr')).toBe(true);
    });

    it('disabling a client revokes its grants and tokens', async () => {
      const dcr = await newClient('disable');
      const grant = await q.saveGrant({ tenantId: tenantA, userId: alice, clientId: dcr.id, scopes: ['mcp'], resource: 'https://gw/mcp' });
      await accessToken(alice, grant.id, 'h-disable');
      const { client, revoked } = await q.setClientDisabled(dcr.id, true);
      expect(client.disabledAt).toBeInstanceOf(Date);
      expect(revoked).toEqual(['h-disable']);
      expect((await auth.findToken('h-disable'))?.token.revokedAt).toBeInstanceOf(Date);
      const reenabled = await q.setClientDisabled(dcr.id, false);
      expect(reenabled.client.disabledAt).toBeNull();
      expect(reenabled.revoked).toEqual([]);
    });

    it('removes stale DCR clients only', async () => {
      const stale = await newClient('stale');
      await t.pool.query("UPDATE oauth_clients SET created_at = now() - interval '40 days' WHERE id = $1", [stale.id]);
      const removed = await q.deleteStaleDcrClients(new Date(Date.now() - 30 * 24 * HOUR));
      expect(removed).toBe(1);
      expect(await q.findClient('dcr_stale')).toBeUndefined();
      expect(await q.findClient(cimd().clientId)).toBeDefined();
    });
  });

  describe('grants', () => {
    it('keeps one active grant per user and client, widening its scopes', async () => {
      const dcr = await newClient('grant');
      const g1 = await q.saveGrant({ tenantId: tenantA, userId: bob, clientId: dcr.id, scopes: ['mcp'], resource: 'https://gw/mcp' });
      const g2 = await q.saveGrant({
        tenantId: tenantA,
        userId: bob,
        clientId: dcr.id,
        scopes: ['mcp', 'offline_access'],
        resource: 'https://gw/mcp/omni',
      });
      expect(g2.id).toBe(g1.id);
      expect(g2.scopes).toEqual(['mcp', 'offline_access']);
      expect(g2.resource).toBe('https://gw/mcp/omni');
      expect((await q.findActiveGrant(bob, dcr.id))?.id).toBe(g1.id);

      await q.revokeGrant(g1.id);
      expect(await q.findActiveGrant(bob, dcr.id)).toBeUndefined();
      const g3 = await q.saveGrant({ tenantId: tenantA, userId: bob, clientId: dcr.id, scopes: ['mcp'], resource: 'https://gw/mcp' });
      expect(g3.id).not.toBe(g1.id);
    });

    it('enforces that only oauth tokens carry a grant', async () => {
      const dcr = await newClient('check');
      const grant = await q.saveGrant({ tenantId: tenantA, userId: alice, clientId: dcr.id, scopes: ['mcp'], resource: 'https://gw/mcp' });
      await expect(auth.createToken(alice, { name: 'x', kind: 'oauth', tokenHash: 'h-no-grant', prefix: 'p' })).rejects.toThrow();
      await expect(
        auth.createToken(alice, { name: 'x', kind: 'api', tokenHash: 'h-api-grant', prefix: 'p', grantId: grant.id }),
      ).rejects.toThrow();
      const ok = await accessToken(alice, grant.id, 'h-with-grant');
      expect(ok.grantId).toBe(grant.id);
    });

    it('lists and revokes per tenant and per user', async () => {
      const dcr = await newClient('tenant');
      const ga = await q.saveGrant({ tenantId: tenantA, userId: alice, clientId: dcr.id, scopes: ['mcp'], resource: 'https://gw/mcp' });
      const gb = await q.saveGrant({ tenantId: tenantB, userId: carol, clientId: dcr.id, scopes: ['mcp'], resource: 'https://gw/mcp' });
      await accessToken(carol, gb.id, 'h-carol');

      const listA = await grantsRepo.list(tenantA);
      expect(listA.items.map((g) => g.id)).toContain(ga.id);
      expect(listA.items.map((g) => g.id)).not.toContain(gb.id);
      expect(listA.items.find((g) => g.id === ga.id)).toMatchObject({ username: 'alice', clientId: 'dcr_tenant', clientKind: 'dcr' });
      expect((await grantsRepo.list(tenantA, { userId: bob })).items.map((g) => g.id)).not.toContain(ga.id);

      await expect(grantsRepo.revoke(tenantA, gb.id)).rejects.toThrow();
      await expect(grantsRepo.revoke(tenantA, ga.id, { userId: bob })).rejects.toThrow();
      expect(await grantsRepo.revoke(tenantB, gb.id)).toEqual(['h-carol']);
      expect((await grantsRepo.list(tenantB)).items.map((g) => g.id)).not.toContain(gb.id);
    });

    it('revokes every grant of a user', async () => {
      const dcr = await newClient('all');
      const g = await q.saveGrant({ tenantId: tenantA, userId: bob, clientId: dcr.id, scopes: ['mcp'], resource: 'https://gw/mcp' });
      await accessToken(bob, g.id, 'h-bob-all');
      expect(await grantsRepo.revokeAllForUser(tenantB, bob)).toEqual([]);
      expect(await grantsRepo.revokeAllForUser(tenantA, bob)).toContain('h-bob-all');
      expect(await q.findActiveGrant(bob, dcr.id)).toBeUndefined();
    });
  });

  describe('authorization codes', () => {
    async function grantWithCode(suffix: string, expiresAt = new Date(Date.now() + 60_000)) {
      const dcr = await newClient(`code-${suffix}`);
      const grant = await q.saveGrant({ tenantId: tenantA, userId: alice, clientId: dcr.id, scopes: ['mcp'], resource: 'https://gw/mcp' });
      await q.createCode({
        codeHash: `code-${suffix}`,
        grantId: grant.id,
        redirectUri: 'http://127.0.0.1/callback',
        codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        resource: 'https://gw/mcp/omni',
        scopes: ['mcp'],
        expiresAt,
      });
      return { dcr, grant };
    }

    it('redeems once, then reports reuse with the grant', async () => {
      const { dcr, grant } = await grantWithCode('once');
      const first = await q.redeemCode('code-once');
      expect(first.status).toBe('ok');
      if (first.status === 'ok') {
        expect(first.value).toMatchObject({ resource: 'https://gw/mcp/omni', redirectUri: 'http://127.0.0.1/callback' });
        expect(first.value.grant.id).toBe(grant.id);
        expect(first.value.client.id).toBe(dcr.id);
      }
      expect(await q.redeemCode('code-once')).toEqual({ status: 'reused', grantId: grant.id });
    });

    it('rejects unknown and expired codes', async () => {
      await grantWithCode('expired', new Date(Date.now() - 1000));
      expect(await q.redeemCode('code-expired')).toEqual({ status: 'invalid' });
      expect(await q.redeemCode('nope')).toEqual({ status: 'invalid' });
    });

    it('rejects codes of revoked grants and disabled clients', async () => {
      const revoked = await grantWithCode('revoked');
      await q.revokeGrant(revoked.grant.id);
      expect(await q.redeemCode('code-revoked')).toEqual({ status: 'invalid' });

      const disabled = await grantWithCode('disabled');
      await t.pool.query('UPDATE oauth_clients SET disabled_at = now() WHERE id = $1', [disabled.dcr.id]);
      expect(await q.redeemCode('code-disabled')).toEqual({ status: 'invalid' });
    });
  });

  describe('refresh tokens', () => {
    async function grantWithRefresh(suffix: string, expiresAt = new Date(Date.now() + HOUR)) {
      const dcr = await newClient(`refresh-${suffix}`);
      const grant = await q.saveGrant({
        tenantId: tenantA,
        userId: alice,
        clientId: dcr.id,
        scopes: ['mcp', 'offline_access'],
        resource: 'https://gw/mcp',
      });
      await q.createRefreshToken(grant.id, `r-${suffix}-1`, expiresAt);
      return grant;
    }

    it('rotates and detects reuse of a rotated token', async () => {
      const grant = await grantWithRefresh('rotate');
      const next = { tokenHash: 'r-rotate-2', expiresAt: new Date(Date.now() + HOUR) };
      const rotated = await q.rotateRefreshToken('r-rotate-1', next);
      expect(rotated.status).toBe('ok');
      if (rotated.status === 'ok') expect(rotated.value.grant.lastUsedAt).toBeInstanceOf(Date);
      expect(await q.rotateRefreshToken('r-rotate-1', { tokenHash: 'r-rotate-3', expiresAt: next.expiresAt })).toEqual({
        status: 'reused',
        grantId: grant.id,
      });
      expect((await q.rotateRefreshToken('r-rotate-2', { tokenHash: 'r-rotate-4', expiresAt: next.expiresAt })).status).toBe('ok');
      expect((await q.findRefreshTokenGrant('r-rotate-1'))?.grant.id).toBe(grant.id);
    });

    it('rejects expired tokens and tokens of revoked grants', async () => {
      await grantWithRefresh('expired', new Date(Date.now() - 1000));
      expect(await q.rotateRefreshToken('r-expired-1', { tokenHash: 'r-expired-2', expiresAt: new Date() })).toEqual({
        status: 'invalid',
      });
      const grant = await grantWithRefresh('revoked');
      await q.revokeGrant(grant.id);
      expect(await q.rotateRefreshToken('r-revoked-1', { tokenHash: 'r-revoked-2', expiresAt: new Date() })).toEqual({
        status: 'invalid',
      });
      expect(await q.rotateRefreshToken('missing', { tokenHash: 'r-missing-2', expiresAt: new Date() })).toEqual({
        status: 'invalid',
      });
    });

    it('purges secrets expired beyond the grace period', async () => {
      await grantWithRefresh('purge', new Date(Date.now() - 2 * 24 * HOUR));
      const purged = await q.purgeExpired();
      expect(purged.refreshTokens).toBeGreaterThanOrEqual(1);
      expect(await q.findRefreshTokenGrant('r-purge-1')).toBeUndefined();
    });
  });
});

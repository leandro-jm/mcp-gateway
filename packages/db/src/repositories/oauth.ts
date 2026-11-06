import { NotFound } from '@mcp-gateway/core';
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../client';
import { apiTokens, oauthAuthorizationCodes, oauthClients, oauthGrants, oauthRefreshTokens, users } from '../schema';
import { pageLimit, pageOffset, type Page, type PageOpts } from './util';

export type OAuthClient = typeof oauthClients.$inferSelect;
export type OAuthGrant = typeof oauthGrants.$inferSelect;

export interface OAuthClientInput {
  clientId: string;
  clientName: string;
  clientUri?: string | null;
  redirectUris: string[];
  applicationType: 'web' | 'native';
  grantTypes?: string[];
}

export interface OAuthGrantInput {
  tenantId: string;
  userId: string;
  /** Row id of the client (`oauth_clients.id`). */
  clientId: string;
  scopes: string[];
  resource: string;
}

export interface AuthorizationCodeInput {
  codeHash: string;
  grantId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: string[];
  expiresAt: Date;
}

export interface GrantWithClient {
  grant: OAuthGrant;
  client: OAuthClient;
}

export interface RedeemedCode extends GrantWithClient {
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: string[];
}

/**
 * Outcome of redeeming a single-use secret. `reused` means it was already redeemed: the caller
 * revokes the grant (RFC 9700 §4.5 and §4.14).
 */
export type RedeemResult<T> = { status: 'ok'; value: T } | { status: 'reused'; grantId: string } | { status: 'invalid' };

export interface ClientListOpts extends PageOpts {
  kind?: OAuthClient['kind'];
}

export type OAuthClientView = OAuthClient & { activeGrants: number };

/** Revokes grants and their access tokens; returns the token hashes to invalidate the verifier's caches. */
async function revokeGrantsWhere(db: Db, where: SQL, at: Date): Promise<string[]> {
  return db.transaction(async (tx) => {
    const grants = await tx
      .update(oauthGrants)
      .set({ revokedAt: at, updatedAt: at })
      .where(and(where, isNull(oauthGrants.revokedAt)))
      .returning({ id: oauthGrants.id });
    if (!grants.length) return [];
    const tokens = await tx
      .update(apiTokens)
      .set({ revokedAt: at })
      .where(and(inArray(apiTokens.grantId, grants.map((g) => g.id)), isNull(apiTokens.revokedAt)))
      .returning({ tokenHash: apiTokens.tokenHash });
    return tokens.map((t) => t.tokenHash);
  });
}

/**
 * Authorization server queries (ADR-030). Clients are platform-wide, and codes and refresh tokens
 * are looked up by hash before the tenant is known, like `AuthQueries`. @cross-tenant
 */
export class OAuthQueries {
  constructor(private readonly db: Db) {}

  // ------------------------------------------------ clients

  async findClient(clientId: string): Promise<OAuthClient | undefined> {
    const [row] = await this.db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId));
    return row;
  }

  /** Stores (or refreshes) the metadata fetched from a CIMD document. */
  async upsertCimdClient(input: OAuthClientInput, fetchedAt = new Date()): Promise<OAuthClient> {
    const values = {
      clientName: input.clientName,
      clientUri: input.clientUri ?? null,
      redirectUris: input.redirectUris,
      applicationType: input.applicationType,
      grantTypes: input.grantTypes ?? ['authorization_code', 'refresh_token'],
      fetchedAt,
      updatedAt: fetchedAt,
    };
    const [row] = await this.db
      .insert(oauthClients)
      .values({ ...values, clientId: input.clientId, kind: 'cimd' })
      .onConflictDoUpdate({ target: oauthClients.clientId, set: values, setWhere: sql`${oauthClients.kind} = 'cimd'` })
      .returning();
    if (!row) throw new NotFound('oauthClient', input.clientId);
    return row;
  }

  async createDcrClient(input: OAuthClientInput): Promise<OAuthClient> {
    const [row] = await this.db
      .insert(oauthClients)
      .values({
        clientId: input.clientId,
        kind: 'dcr',
        clientName: input.clientName,
        clientUri: input.clientUri ?? null,
        redirectUris: input.redirectUris,
        applicationType: input.applicationType,
        grantTypes: input.grantTypes ?? ['authorization_code', 'refresh_token'],
      })
      .returning();
    return row!;
  }

  async touchClient(id: string, at = new Date()): Promise<void> {
    await this.db.update(oauthClients).set({ lastUsedAt: at }).where(eq(oauthClients.id, id));
  }

  /** Disables or re-enables a client; disabling revokes every grant of it. Returns the token hashes revoked. */
  async setClientDisabled(id: string, disabled: boolean, at = new Date()): Promise<{ client: OAuthClient; revoked: string[] }> {
    const [client] = await this.db
      .update(oauthClients)
      .set({ disabledAt: disabled ? at : null, updatedAt: at })
      .where(eq(oauthClients.id, id))
      .returning();
    if (!client) throw new NotFound('oauthClient', id);
    const revoked = disabled ? await revokeGrantsWhere(this.db, eq(oauthGrants.clientId, id), at) : [];
    return { client, revoked };
  }

  async listClients(opts: ClientListOpts = {}): Promise<Page<OAuthClientView>> {
    const where = opts.kind ? eq(oauthClients.kind, opts.kind) : undefined;
    const active = this.db
      .select({ clientId: oauthGrants.clientId, n: count().as('n') })
      .from(oauthGrants)
      .where(isNull(oauthGrants.revokedAt))
      .groupBy(oauthGrants.clientId)
      .as('active');
    const rows = await this.db
      .select({ client: oauthClients, n: active.n })
      .from(oauthClients)
      .leftJoin(active, eq(active.clientId, oauthClients.id))
      .where(where)
      .orderBy(desc(oauthClients.createdAt))
      .limit(pageLimit(opts))
      .offset(pageOffset(opts));
    const [c] = await this.db.select({ n: count() }).from(oauthClients).where(where);
    return { items: rows.map((r) => ({ ...r.client, activeGrants: Number(r.n ?? 0) })), total: c?.n ?? 0 };
  }

  /** Removes DCR clients unused since `before` (with their grants). Returns how many were removed. */
  async deleteStaleDcrClients(before: Date): Promise<number> {
    const rows = await this.db
      .delete(oauthClients)
      .where(and(eq(oauthClients.kind, 'dcr'), lt(sql`coalesce(${oauthClients.lastUsedAt}, ${oauthClients.createdAt})`, before)))
      .returning({ id: oauthClients.id });
    return rows.length;
  }

  // ------------------------------------------------ grants

  async findActiveGrant(userId: string, clientRowId: string): Promise<OAuthGrant | undefined> {
    const [row] = await this.db
      .select()
      .from(oauthGrants)
      .where(and(eq(oauthGrants.userId, userId), eq(oauthGrants.clientId, clientRowId), isNull(oauthGrants.revokedAt)));
    return row;
  }

  /** Creates the user's grant for the client, or widens the active one with the new scopes. */
  async saveGrant(input: OAuthGrantInput, at = new Date()): Promise<OAuthGrant> {
    const current = await this.findActiveGrant(input.userId, input.clientId);
    const scopes = [...new Set([...(current?.scopes ?? []), ...input.scopes])];
    const [row] = await this.db
      .insert(oauthGrants)
      .values({ ...input, scopes })
      .onConflictDoUpdate({
        target: [oauthGrants.userId, oauthGrants.clientId],
        targetWhere: sql`${oauthGrants.revokedAt} is null`,
        set: { scopes, resource: input.resource, updatedAt: at },
      })
      .returning();
    return row!;
  }

  async findGrant(grantId: string): Promise<GrantWithClient | undefined> {
    const [row] = await this.db
      .select({ grant: oauthGrants, client: oauthClients })
      .from(oauthGrants)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
      .where(eq(oauthGrants.id, grantId));
    return row;
  }

  async revokeGrant(grantId: string, at = new Date()): Promise<string[]> {
    return revokeGrantsWhere(this.db, eq(oauthGrants.id, grantId), at);
  }

  private async activeGrant(grantId: string): Promise<GrantWithClient | undefined> {
    const found = await this.findGrant(grantId);
    return found && !found.grant.revokedAt && !found.client.disabledAt ? found : undefined;
  }

  // ------------------------------------------------ authorization codes

  async createCode(input: AuthorizationCodeInput): Promise<void> {
    await this.db.insert(oauthAuthorizationCodes).values(input);
  }

  /** Redeems a code exactly once; a second attempt reports `reused`. */
  async redeemCode(codeHash: string, now = new Date()): Promise<RedeemResult<RedeemedCode>> {
    const [code] = await this.db
      .update(oauthAuthorizationCodes)
      .set({ usedAt: now })
      .where(
        and(
          eq(oauthAuthorizationCodes.codeHash, codeHash),
          isNull(oauthAuthorizationCodes.usedAt),
          gt(oauthAuthorizationCodes.expiresAt, now),
        ),
      )
      .returning();
    if (!code) {
      const [used] = await this.db
        .select({ grantId: oauthAuthorizationCodes.grantId })
        .from(oauthAuthorizationCodes)
        .where(and(eq(oauthAuthorizationCodes.codeHash, codeHash), isNotNull(oauthAuthorizationCodes.usedAt)));
      return used ? { status: 'reused', grantId: used.grantId } : { status: 'invalid' };
    }
    const found = await this.activeGrant(code.grantId);
    if (!found) return { status: 'invalid' };
    return {
      status: 'ok',
      value: {
        ...found,
        redirectUri: code.redirectUri,
        codeChallenge: code.codeChallenge,
        resource: code.resource,
        scopes: code.scopes,
      },
    };
  }

  // ------------------------------------------------ refresh tokens

  async createRefreshToken(grantId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.db.insert(oauthRefreshTokens).values({ grantId, tokenHash, expiresAt });
  }

  /**
   * Rotates a refresh token: marks it used and stores its successor in one transaction. A token
   * that was already rotated reports `reused`; an expired one, or one of a revoked grant, `invalid`.
   */
  async rotateRefreshToken(
    tokenHash: string,
    next: { tokenHash: string; expiresAt: Date },
    now = new Date(),
  ): Promise<RedeemResult<GrantWithClient>> {
    const result = await this.db.transaction(async (tx): Promise<RedeemResult<string>> => {
      const [current] = await tx
        .update(oauthRefreshTokens)
        .set({ rotatedAt: now })
        .where(
          and(eq(oauthRefreshTokens.tokenHash, tokenHash), isNull(oauthRefreshTokens.rotatedAt), gt(oauthRefreshTokens.expiresAt, now)),
        )
        .returning({ grantId: oauthRefreshTokens.grantId });
      if (!current) {
        const [rotated] = await tx
          .select({ grantId: oauthRefreshTokens.grantId })
          .from(oauthRefreshTokens)
          .where(and(eq(oauthRefreshTokens.tokenHash, tokenHash), isNotNull(oauthRefreshTokens.rotatedAt)));
        return rotated ? { status: 'reused', grantId: rotated.grantId } : { status: 'invalid' };
      }
      const [grant] = await tx
        .update(oauthGrants)
        .set({ lastUsedAt: now })
        .where(and(eq(oauthGrants.id, current.grantId), isNull(oauthGrants.revokedAt)))
        .returning({ id: oauthGrants.id });
      if (!grant) return { status: 'invalid' };
      await tx.insert(oauthRefreshTokens).values({ grantId: grant.id, tokenHash: next.tokenHash, expiresAt: next.expiresAt });
      return { status: 'ok', value: grant.id };
    });
    if (result.status !== 'ok') return result;
    const found = await this.activeGrant(result.value);
    return found ? { status: 'ok', value: found } : { status: 'invalid' };
  }

  /** Grant behind a refresh token, current or rotated (revocation endpoint, RFC 7009). */
  async findRefreshTokenGrant(tokenHash: string): Promise<GrantWithClient | undefined> {
    const [row] = await this.db
      .select({ grantId: oauthRefreshTokens.grantId })
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.tokenHash, tokenHash));
    return row ? this.findGrant(row.grantId) : undefined;
  }

  /** Deletes codes and refresh tokens expired for more than `graceMs` (they only serve reuse detection until then). */
  async purgeExpired(now = new Date(), graceMs = 24 * 3_600_000): Promise<{ codes: number; refreshTokens: number }> {
    const before = new Date(now.getTime() - graceMs);
    const codes = await this.db
      .delete(oauthAuthorizationCodes)
      .where(lt(oauthAuthorizationCodes.expiresAt, before))
      .returning({ h: oauthAuthorizationCodes.codeHash });
    const refresh = await this.db
      .delete(oauthRefreshTokens)
      .where(lt(oauthRefreshTokens.expiresAt, before))
      .returning({ id: oauthRefreshTokens.id });
    return { codes: codes.length, refreshTokens: refresh.length };
  }
}

/** Grant as listed in the Admin UI ("Connected apps"); never includes secrets. */
export interface OAuthGrantView {
  id: string;
  userId: string;
  username: string;
  clientId: string;
  clientName: string;
  clientKind: OAuthClient['kind'];
  scopes: string[];
  resource: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface GrantListOpts extends PageOpts {
  userId?: string;
}

/** A tenant's OAuth grants (ADR-030): listing and revocation for admins and for the user. */
export class OAuthGrantsRepo {
  constructor(private readonly db: Db) {}

  private where(tenantId: string, userId?: string): SQL {
    const scope = and(eq(oauthGrants.tenantId, tenantId), isNull(oauthGrants.revokedAt));
    return (userId ? and(scope, eq(oauthGrants.userId, userId)) : scope)!;
  }

  async list(tenantId: string, opts: GrantListOpts = {}): Promise<Page<OAuthGrantView>> {
    const where = this.where(tenantId, opts.userId);
    const items = await this.db
      .select({
        id: oauthGrants.id,
        userId: oauthGrants.userId,
        username: users.username,
        clientId: oauthClients.clientId,
        clientName: oauthClients.clientName,
        clientKind: oauthClients.kind,
        scopes: oauthGrants.scopes,
        resource: oauthGrants.resource,
        createdAt: oauthGrants.createdAt,
        lastUsedAt: oauthGrants.lastUsedAt,
      })
      .from(oauthGrants)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
      .innerJoin(users, eq(users.id, oauthGrants.userId))
      .where(where)
      .orderBy(desc(sql`coalesce(${oauthGrants.lastUsedAt}, ${oauthGrants.createdAt})`))
      .limit(pageLimit(opts))
      .offset(pageOffset(opts));
    const [c] = await this.db.select({ n: count() }).from(oauthGrants).where(where);
    return { items, total: c?.n ?? 0 };
  }

  /** Revokes one grant of the tenant (optionally only if it belongs to `userId`). Returns the token hashes revoked. */
  async revoke(tenantId: string, grantId: string, opts: { userId?: string } = {}): Promise<string[]> {
    const [found] = await this.db
      .select({ id: oauthGrants.id })
      .from(oauthGrants)
      .where(and(this.where(tenantId, opts.userId), eq(oauthGrants.id, grantId)));
    if (!found) throw new NotFound('oauthGrant', grantId);
    return revokeGrantsWhere(this.db, eq(oauthGrants.id, grantId), new Date());
  }

  /** Revokes every grant of a user (password change, disable). Returns the token hashes revoked. */
  async revokeAllForUser(tenantId: string, userId: string): Promise<string[]> {
    return revokeGrantsWhere(this.db, and(eq(oauthGrants.tenantId, tenantId), eq(oauthGrants.userId, userId))!, new Date());
  }

  /** Revokes the grants of a client in this tenant (client removed from the allowlist). */
  async revokeForClient(tenantId: string, clientRowId: string): Promise<string[]> {
    return revokeGrantsWhere(this.db, and(eq(oauthGrants.tenantId, tenantId), eq(oauthGrants.clientId, clientRowId))!, new Date());
  }
}

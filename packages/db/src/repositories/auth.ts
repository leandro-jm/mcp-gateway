import { Conflict, NotFound } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { apiTokens, tenants, users } from '../schema';
import { apiTokenColumns, type ApiToken, type ApiTokenInput } from './api-tokens';
import type { Tenant } from './tenants';
import { toUser, wrapUserConflict, type User, type UserInput } from './users';
import { isUniqueViolation } from './util';

/** Serializes concurrent first-run setups (ADR-024). */
const SETUP_LOCK_KEY = 727_276;

export interface AuthTenant {
  id: string;
  slug: string;
  status: 'active' | 'suspended';
}

export interface TokenRecord {
  token: ApiToken;
  user: User;
  /** Absent for platform admins. */
  tenant: AuthTenant | null;
}

export interface LoginRecord {
  user: User;
  passwordHash: string | null;
  tenant: AuthTenant | null;
}

/**
 * Authentication queries (ADR-011). They resolve the identity before a tenant is known
 * (lookup by token hash, login by username) and handle the user's own tokens
 * and platform admins. @cross-tenant
 */
export class AuthQueries {
  constructor(private readonly db: Db) {}

  async findToken(tokenHash: string): Promise<TokenRecord | undefined> {
    const [row] = await this.db
      .select({ token: apiTokenColumns, user: users, tenant: { id: tenants.id, slug: tenants.slug, status: tenants.status } })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .leftJoin(tenants, eq(tenants.id, users.tenantId))
      .where(eq(apiTokens.tokenHash, tokenHash));
    if (!row) return undefined;
    return { token: row.token, user: toUser(row.user), tenant: row.tenant };
  }

  async findLogin(username: string): Promise<LoginRecord | undefined> {
    const [row] = await this.db
      .select({ user: users, tenant: { id: tenants.id, slug: tenants.slug, status: tenants.status } })
      .from(users)
      .leftJoin(tenants, eq(tenants.id, users.tenantId))
      .where(eq(users.username, username));
    if (!row) return undefined;
    return { user: toUser(row.user), passwordHash: row.user.passwordHash, tenant: row.tenant };
  }

  /** Sets the user's own language (`PATCH /me`); works for platform admins, who have no tenant. */
  async setLocale(userId: string, locale: User['locale']): Promise<void> {
    const rows = await this.db.update(users).set({ locale, updatedAt: new Date() }).where(eq(users.id, userId)).returning({ id: users.id });
    if (!rows.length) throw new NotFound('user', userId);
  }

  async touchToken(id: string, at = new Date()): Promise<void> {
    await this.db.update(apiTokens).set({ lastUsedAt: at }).where(eq(apiTokens.id, id));
  }

  // ------------------------------------------------ the user's own tokens (/me, login)

  async createToken(userId: string, input: ApiTokenInput): Promise<ApiToken> {
    const [row] = await this.db
      .insert(apiTokens)
      .values({ ...input, userId })
      .returning(apiTokenColumns);
    return row!;
  }

  async listTokens(userId: string): Promise<ApiToken[]> {
    return this.db
      .select(apiTokenColumns)
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, userId), eq(apiTokens.kind, 'api'), isNull(apiTokens.revokedAt)))
      .orderBy(desc(apiTokens.createdAt));
  }

  /** Revokes a token of the user and returns its hash. */
  async revokeToken(userId: string, id: string): Promise<string> {
    const [row] = await this.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.userId, userId), eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
      .returning({ tokenHash: apiTokens.tokenHash });
    if (!row) throw new NotFound('token', id);
    return row.tokenHash;
  }

  async revokeByHash(tokenHash: string): Promise<void> {
    await this.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.tokenHash, tokenHash), isNull(apiTokens.revokedAt)));
  }

  // ------------------------------------------------ platform admins and bootstrap

  /** Creates a user in any tenant (`null` = platform admin). Used by the seed and the CLI. */
  async createUser(tenantId: string | null, input: UserInput): Promise<User> {
    try {
      const [row] = await this.db
        .insert(users)
        .values({ ...input, tenantId })
        .returning();
      return toUser(row!);
    } catch (err) {
      return wrapUserConflict(err, input.username);
    }
  }

  /** Whether any user exists: the first-run setup (ADR-024) only acts on an empty instance. */
  async hasUsers(): Promise<boolean> {
    const [row] = await this.db.select({ id: users.id }).from(users).limit(1);
    return Boolean(row);
  }

  /**
   * First-run setup (ADR-024): creates the first tenant and a platform admin in one transaction.
   * Returns `undefined` when a user already exists (another setup or the CLI got there first).
   */
  async bootstrap(input: { tenant: { slug: string; name: string }; admin: UserInput }): Promise<{ tenant: Tenant; user: User } | undefined> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SETUP_LOCK_KEY})`);
      const [existing] = await tx.select({ id: users.id }).from(users).limit(1);
      if (existing) return undefined;
      let tenant: Tenant;
      try {
        [tenant] = (await tx
          .insert(tenants)
          .values(input.tenant)
          .returning({
            id: tenants.id,
            slug: tenants.slug,
            name: tenants.name,
            status: tenants.status,
            settings: tenants.settings,
            createdAt: tenants.createdAt,
            updatedAt: tenants.updatedAt,
          })) as [Tenant];
      } catch (err) {
        if (isUniqueViolation(err)) throw new Conflict(msg('db.tenantExists', { slug: input.tenant.slug }));
        throw err;
      }
      const [row] = await tx
        .insert(users)
        .values({ ...input.admin, tenantId: null, roles: ['gateway-admin'] })
        .returning();
      return { tenant, user: toUser(row!) };
    });
  }

  async findUser(username: string): Promise<User | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.username, username));
    return row ? toUser(row) : undefined;
  }

  async listPlatformAdmins(): Promise<User[]> {
    const rows = await this.db.select().from(users).where(isNull(users.tenantId)).orderBy(asc(users.username));
    return rows.map(toUser);
  }

  async setPasswordHash(userId: string, hash: string | null): Promise<void> {
    const rows = await this.db
      .update(users)
      .set({ passwordHash: hash, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({ id: users.id });
    if (!rows.length) throw new NotFound('user', userId);
  }
}

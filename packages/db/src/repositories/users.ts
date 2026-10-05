import { Conflict, NotFound } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import { and, asc, count, eq } from 'drizzle-orm';
import type { Db } from '../client';
import { users, type JsonObject } from '../schema';
import { isUniqueViolation, pageLimit, pageOffset, type Page, type PageOpts } from './util';

/** User without the password hash (it never leaves the repository). */
export type User = Omit<typeof users.$inferSelect, 'passwordHash'> & { hasPassword: boolean };

export interface UserInput {
  username: string;
  displayName?: string | null;
  kind?: User['kind'];
  passwordHash?: string | null;
  roles?: string[];
  groups?: string[];
  attributes?: JsonObject;
  status?: User['status'];
  locale?: User['locale'];
}

export type UserPatch = Partial<Omit<UserInput, 'username' | 'passwordHash'>>;

export function toUser(row: typeof users.$inferSelect): User {
  const { passwordHash: hash, ...rest } = row;
  return { ...rest, hasPassword: Boolean(hash) };
}

export function wrapUserConflict(err: unknown, username: string): never {
  if (isUniqueViolation(err)) throw new Conflict(msg('db.userExists', { username }));
  throw err;
}

/** A tenant's users (ADR-011). Platform admins (without a tenant) live in `AuthQueries`. */
export class UsersRepo {
  constructor(private readonly db: Db) {}

  async list(tenantId: string, opts: PageOpts = {}): Promise<Page<User>> {
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.tenantId, tenantId))
      .orderBy(asc(users.username))
      .limit(pageLimit(opts))
      .offset(pageOffset(opts));
    const [c] = await this.db.select({ n: count() }).from(users).where(eq(users.tenantId, tenantId));
    return { items: rows.map(toUser), total: c?.n ?? 0 };
  }

  async get(tenantId: string, id: string): Promise<User> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, id)));
    if (!row) throw new NotFound('user', id);
    return toUser(row);
  }

  async findByUsername(tenantId: string, username: string): Promise<User | undefined> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.username, username)));
    return row ? toUser(row) : undefined;
  }

  async create(tenantId: string, input: UserInput): Promise<User> {
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

  async update(tenantId: string, id: string, patch: UserPatch): Promise<User> {
    const [row] = await this.db
      .update(users)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(users.tenantId, tenantId), eq(users.id, id)))
      .returning();
    if (!row) throw new NotFound('user', id);
    return toUser(row);
  }

  async setPasswordHash(tenantId: string, id: string, hash: string | null): Promise<void> {
    const rows = await this.db
      .update(users)
      .set({ passwordHash: hash, updatedAt: new Date() })
      .where(and(eq(users.tenantId, tenantId), eq(users.id, id)))
      .returning({ id: users.id });
    if (!rows.length) throw new NotFound('user', id);
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const rows = await this.db
      .delete(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, id)))
      .returning({ id: users.id });
    if (!rows.length) throw new NotFound('user', id);
  }
}

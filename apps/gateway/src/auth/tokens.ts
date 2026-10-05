import { hashToken, Unauthorized } from '@mcp-gateway/core';
import type { AuthQueries, TokenRecord } from '@mcp-gateway/db';
import type { Locale } from '@mcp-gateway/i18n';
import { msg } from '@mcp-gateway/i18n/server';

export interface Principal {
  /** Username of the token owner (unique and immutable). */
  sub: string;
  /** Slug of the user's tenant; absent for platform admins. */
  tenant: string | undefined;
  roles: string[];
  groups: string[];
  /** Token name (used by `client` policies and rate limiting); `me/<name>` for self-issued tokens. */
  clientId: string | undefined;
  kind?: 'human' | 'service';
  /** User attributes, exposed to policy conditions as `claims.*`. */
  claims: Record<string, unknown>;
  /** Language of the messages returned to this user (ADR-012). */
  locale: Locale;
  userId?: string;
  tokenId?: string;
}

export interface TokenVerifierOptions {
  /** Lookup cache TTL (ms). A revocation on another replica takes at most this long. */
  cacheTtlMs?: number;
  /** Minimum interval between `last_used_at` updates (ms). */
  touchIntervalMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface CacheEntry {
  at: number;
  record?: TokenRecord;
}

export function toPrincipal({ token, user, tenant }: TokenRecord): Principal {
  return {
    sub: user.username,
    tenant: tenant?.slug,
    roles: user.roles,
    groups: user.groups,
    clientId: token.selfIssued ? `me/${token.name}` : token.name,
    kind: user.kind,
    claims: { ...user.attributes, sub: user.username, name: user.displayName ?? user.username, preferred_username: user.username },
    locale: user.locale,
    userId: user.id,
    tokenId: token.id,
  };
}

/** Validates opaque tokens against Postgres (ADR-011), with a short in-memory cache. */
export class TokenVerifier {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly touched = new Map<string, number>();
  private readonly ttl: number;
  private readonly touchInterval: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(
    private readonly auth: AuthQueries,
    opts: TokenVerifierOptions = {},
  ) {
    this.ttl = opts.cacheTtlMs ?? 15_000;
    this.touchInterval = opts.touchIntervalMs ?? 60_000;
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  private async lookup(hash: string): Promise<TokenRecord | undefined> {
    const cached = this.cache.get(hash);
    if (cached && this.now() - cached.at < this.ttl) return cached.record;
    const record = await this.auth.findToken(hash);
    if (this.cache.size >= this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(hash, { at: this.now(), ...(record ? { record } : {}) });
    return record;
  }

  async verify(token: string): Promise<Principal> {
    const hash = hashToken(token);
    const record = await this.lookup(hash);
    if (!record) throw new Unauthorized(msg('auth.invalidToken'));
    if (record.token.revokedAt) throw new Unauthorized(msg('auth.revokedToken'));
    if (record.token.expiresAt && record.token.expiresAt.getTime() <= this.now()) throw new Unauthorized(msg('auth.expiredToken'));
    if (record.user.status !== 'active') throw new Unauthorized(msg('auth.userDisabled'));
    if (record.tenant && record.tenant.status !== 'active') {
      throw new Unauthorized(msg('auth.tenantInactive', { tenant: record.tenant.slug, status: record.tenant.status }));
    }
    this.touch(record.token.id);
    return toPrincipal(record);
  }

  /** Drops the cache of a token (revocation, logout, user change). */
  forget(...hashes: string[]): void {
    for (const h of hashes) this.cache.delete(h);
  }

  /** Drops the whole cache (e.g. user changed; we don't know every cached hash). */
  clear(): void {
    this.cache.clear();
  }

  private touch(tokenId: string): void {
    const last = this.touched.get(tokenId);
    const now = this.now();
    if (last !== undefined && now - last < this.touchInterval) return;
    if (this.touched.size >= this.maxEntries) this.touched.clear();
    this.touched.set(tokenId, now);
    this.auth.touchToken(tokenId, new Date(now)).catch(() => undefined);
  }
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m?.[1]?.trim();
}

/** `WWW-Authenticate` header value for data plane 401 responses. */
export function wwwAuthenticate(error?: string, description?: string): string {
  const parts = [`Bearer realm="mcp-gateway"`];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  return parts.join(', ');
}

import { hashToken, readOAuthSettings, Unauthorized } from '@mcp-gateway/core';
import type { AuthQueries, OAuthTokenInfo, TokenRecord } from '@mcp-gateway/db';
import type { Locale } from '@mcp-gateway/i18n';
import { msg } from '@mcp-gateway/i18n/server';
import { clientInAllowlist, clientMetadataHost, protectedResourceMetadataUrl } from '@mcp-gateway/oauth';

export interface Principal {
  /** Username of the token owner (unique and immutable). */
  sub: string;
  /** Slug of the user's tenant; absent for platform admins. */
  tenant: string | undefined;
  roles: string[];
  groups: string[];
  /**
   * Token name (used by `client` policies and rate limiting); `me/<name>` for self-issued tokens;
   * `oauth:<host>` (CIMD) or `oauth:dcr:<client_id>` for tokens issued to a connected app (ADR-030).
   */
  clientId: string | undefined;
  kind?: 'human' | 'service';
  /** User attributes, exposed to policy conditions as `claims.*`. */
  claims: Record<string, unknown>;
  /** Language of the messages returned to this user (ADR-012). */
  locale: Locale;
  userId?: string;
  tokenId?: string;
  /** Kind of the token behind the principal; `oauth` tokens only work on the data plane. */
  tokenKind?: 'session' | 'api' | 'oauth';
  /** OAuth scopes granted to the token (empty for other kinds). */
  scopes?: string[];
}

export interface TokenVerifierOptions {
  /** Platform switch `OAUTH_ENABLED`: while off, `oauth` tokens are rejected. */
  oauthEnabled?: boolean;
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

/** `clientId` of a connected app: the CIMD host is verifiable, a DCR name is not (ADR-030). */
export function oauthClientId(oauth: Pick<OAuthTokenInfo, 'clientId' | 'clientKind'>): string {
  return oauth.clientKind === 'cimd' ? `oauth:${clientMetadataHost(oauth.clientId)}` : `oauth:dcr:${oauth.clientId}`;
}

function clientIdOf({ token, oauth }: TokenRecord): string {
  if (oauth) return oauthClientId(oauth);
  return token.selfIssued ? `me/${token.name}` : token.name;
}

export function toPrincipal(record: TokenRecord): Principal {
  const { token, user, tenant } = record;
  return {
    sub: user.username,
    tenant: tenant?.slug,
    roles: user.roles,
    groups: user.groups,
    clientId: clientIdOf(record),
    kind: user.kind,
    claims: { ...user.attributes, sub: user.username, name: user.displayName ?? user.username, preferred_username: user.username },
    locale: user.locale,
    userId: user.id,
    tokenId: token.id,
    tokenKind: token.kind,
    scopes: record.oauth?.scopes ?? [],
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
  private readonly oauthEnabled: boolean;

  constructor(
    private readonly auth: AuthQueries,
    opts: TokenVerifierOptions = {},
  ) {
    this.ttl = opts.cacheTtlMs ?? 15_000;
    this.touchInterval = opts.touchIntervalMs ?? 60_000;
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.now = opts.now ?? Date.now;
    this.oauthEnabled = opts.oauthEnabled ?? false;
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
    if (record.token.kind === 'oauth') this.checkOAuth(record);
    this.touch(record.token.id);
    return toPrincipal(record);
  }

  /**
   * A connected app's token stays valid only while everything that allowed it still holds: the
   * platform and tenant switches, the grant, the client and the tenant allowlist (ADR-030).
   */
  private checkOAuth(record: TokenRecord): void {
    const oauth = record.oauth;
    if (!this.oauthEnabled) throw new Unauthorized(msg('auth.oauthPlatformDisabled'));
    if (!oauth || oauth.grantRevokedAt) throw new Unauthorized(msg('auth.revokedToken'));
    if (oauth.clientDisabledAt) throw new Unauthorized(msg('oauth.reason.client_disabled'));
    if (record.user.kind !== 'human') throw new Unauthorized(msg('oauth.reason.user_not_allowed'));
    const settings = readOAuthSettings({ oauth: oauth.tenantSettings });
    if (!settings.enabled) throw new Unauthorized(msg('oauth.reason.tenant_oauth_disabled'));
    if (settings.clients === 'allowlist' && !clientInAllowlist(settings.allowlist, { clientId: oauth.clientId, kind: oauth.clientKind })) {
      throw new Unauthorized(msg('oauth.reason.client_not_allowed'));
    }
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

export interface ChallengeOptions {
  /** The MCP resource the client called; with OAuth on, its Protected Resource Metadata is announced (RFC 9728 §5.1). */
  resource?: string;
  /** Scopes the client should request (MCP spec 2026-07-28, scope selection). */
  scope?: string;
}

/** `WWW-Authenticate` header value for data plane 401 responses. */
export function wwwAuthenticate(error?: string, description?: string, opts: ChallengeOptions = {}): string {
  const parts = [`Bearer realm="mcp-gateway"`];
  if (opts.resource) parts.push(`resource_metadata="${protectedResourceMetadataUrl(opts.resource)}"`);
  if (opts.scope) parts.push(`scope="${opts.scope}"`);
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  return parts.join(', ');
}

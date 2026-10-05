import { randomUUID } from 'node:crypto';
import { decrypt, encrypt, UpstreamError, type NetworkPolicy } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import { MAX_TOKEN_RESPONSE_BYTES, outboundFetch, readLimited } from '@mcp-gateway/net';
import type { CredentialsRepo, DecryptedCredential, Keyring } from '@mcp-gateway/db';
import type { Redis } from 'ioredis';
import type { Logger } from '../logger';
import type { HttpRequestSpec } from './types';

export interface CredentialManagerOptions {
  /** Renews the token before it expires (seconds). */
  refreshMarginSeconds?: number;
  /** TTL of the distributed refresh lock. */
  lockTtlMs?: number;
  /** How long to wait for another replica to obtain the token. */
  waitTimeoutMs?: number;
  /** In-memory cache of the decrypted configuration. */
  configCacheMs?: number;
  tokenTimeoutMs?: number;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenKey = (tenantId: string, credId: string, version: number) => `cred:token:${tenantId}:${credId}:${version}`;
const lockKey = (tenantId: string, credId: string, version: number) => `cred:lock:${tenantId}:${credId}:${version}`;

/**
 * Injects credentials into upstream requests. The agent never sees credentials.
 *
 * OAuth2 tokens are cached in Redis (encrypted with the tenant data key) until
 * `expires_in - margin`. Refresh uses a distributed lock (`SET NX PX`) and concurrent
 * calls in the same process share the same promise, which avoids hammering the
 * token endpoint.
 */
export class CredentialManager {
  private readonly configs = new Map<string, { cred: DecryptedCredential; expiresAt: number }>();
  private readonly tokens = new Map<string, CachedToken>();
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly margin: number;
  private readonly lockTtl: number;
  private readonly waitTimeout: number;
  private readonly configTtl: number;
  private readonly tokenTimeout: number;

  constructor(
    private readonly repo: CredentialsRepo,
    private readonly keyring: Keyring,
    private readonly redis: Redis,
    private readonly logger: Logger,
    opts: CredentialManagerOptions = {},
  ) {
    this.margin = (opts.refreshMarginSeconds ?? 30) * 1000;
    this.lockTtl = opts.lockTtlMs ?? 10_000;
    this.waitTimeout = opts.waitTimeoutMs ?? 10_000;
    this.configTtl = opts.configCacheMs ?? 60_000;
    this.tokenTimeout = opts.tokenTimeoutMs ?? 10_000;
  }

  /** Drops a tenant's caches (credential rotation via the Admin API). */
  forgetTenant(tenantId: string): void {
    for (const k of this.configs.keys()) if (k.startsWith(`${tenantId}:`)) this.configs.delete(k);
    for (const k of this.tokens.keys()) if (k.includes(`:${tenantId}:`)) this.tokens.delete(k);
  }

  private async credential(tenantId: string, credentialId: string): Promise<DecryptedCredential> {
    const k = `${tenantId}:${credentialId}`;
    const hit = this.configs.get(k);
    if (hit && hit.expiresAt > Date.now()) return hit.cred;
    const cred = await this.repo.getDecrypted(tenantId, credentialId);
    this.configs.set(k, { cred, expiresAt: Date.now() + this.configTtl });
    return cred;
  }

  /**
   * Applies the credential to the request. For OAuth, returns the token used (for
   * selective invalidation on a 401); for the other types, `null`.
   */
  async apply(tenantId: string, credentialId: string, req: HttpRequestSpec, network: NetworkPolicy): Promise<string | null> {
    const cred = await this.credential(tenantId, credentialId);
    const cfg = cred.config as Record<string, unknown>;
    switch (cred.type) {
      case 'bearer_static':
        req.headers.authorization = `Bearer ${cfg.token}`;
        return null;
      case 'basic':
        req.headers.authorization = `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`;
        return null;
      case 'api_key':
        if (cfg.in === 'query') req.url.searchParams.set(String(cfg.name), String(cfg.value));
        else req.headers[String(cfg.name).toLowerCase()] = String(cfg.value);
        return null;
      case 'oauth2_client_credentials':
      case 'oauth2_password': {
        const token = await this.token(tenantId, cred, network);
        req.headers.authorization = `Bearer ${token}`;
        return token;
      }
    }
  }

  /**
   * Invalidates a token rejected by the upstream (401). Only deletes the shared token
   * if it is still the one that failed: another replica may already have a new one.
   */
  async invalidateToken(tenantId: string, credentialId: string, staleToken: string): Promise<void> {
    const cred = await this.credential(tenantId, credentialId);
    const key = tokenKey(tenantId, cred.id, cred.version);
    if (this.tokens.get(key)?.token === staleToken) this.tokens.delete(key);
    const shared = await this.readShared(tenantId, key);
    if (shared?.token === staleToken) await this.redis.del(key);
  }

  private async token(tenantId: string, cred: DecryptedCredential, network: NetworkPolicy): Promise<string> {
    const key = tokenKey(tenantId, cred.id, cred.version);
    const local = this.tokens.get(key);
    if (local && local.expiresAt - this.margin > Date.now()) return local.token;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = this.resolveToken(tenantId, cred, key, network).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async readShared(tenantId: string, key: string): Promise<CachedToken | undefined> {
    const raw = await this.redis.get(key);
    if (!raw) return undefined;
    try {
      const dataKey = await this.keyring.dataKey(tenantId);
      const t = JSON.parse(decrypt(dataKey, raw, key).toString('utf8')) as CachedToken;
      return t.expiresAt - this.margin > Date.now() ? t : undefined;
    } catch {
      return undefined;
    }
  }

  private async resolveToken(tenantId: string, cred: DecryptedCredential, key: string, network: NetworkPolicy): Promise<string> {
    const shared = await this.readShared(tenantId, key);
    if (shared) {
      this.tokens.set(key, shared);
      return shared.token;
    }
    const lock = lockKey(tenantId, cred.id, cred.version);
    const owner = randomUUID();
    const deadline = Date.now() + this.waitTimeout;
    for (;;) {
      const acquired = await this.redis.set(lock, owner, 'PX', this.lockTtl, 'NX');
      if (acquired === 'OK') {
        try {
          // Another replica may have written it between the GET and the lock.
          const again = await this.readShared(tenantId, key);
          if (again) {
            this.tokens.set(key, again);
            return again.token;
          }
          const fresh = await this.fetchToken(cred, network);
          const dataKey = await this.keyring.dataKey(tenantId);
          const ttlMs = Math.max(fresh.expiresAt - Date.now(), 1000);
          await this.redis.set(key, encrypt(dataKey, JSON.stringify(fresh), key), 'PX', ttlMs);
          this.tokens.set(key, fresh);
          return fresh.token;
        } finally {
          // Release only if still the lock owner.
          await this.redis.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            1,
            lock,
            owner,
          );
        }
      }
      if (Date.now() > deadline) throw new UpstreamError(msg('proxy.tokenWaitTimeout'));
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 25));
      const waited = await this.readShared(tenantId, key);
      if (waited) {
        this.tokens.set(key, waited);
        return waited.token;
      }
    }
  }

  private async fetchToken(cred: DecryptedCredential, network: NetworkPolicy): Promise<CachedToken> {
    const cfg = cred.config as Record<string, unknown>;
    const grant = cred.type === 'oauth2_password' ? 'password' : 'client_credentials';
    const body = new URLSearchParams({ grant_type: grant });
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if (cfg.authMethod === 'basic') {
      headers.authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret ?? ''}`).toString('base64')}`;
    } else {
      body.set('client_id', String(cfg.clientId));
      if (cfg.clientSecret) body.set('client_secret', String(cfg.clientSecret));
    }
    if (grant === 'password') {
      body.set('username', String(cfg.username));
      body.set('password', String(cfg.password));
    }
    if (cfg.scope) body.set('scope', String(cfg.scope));
    if (cfg.audience) body.set('audience', String(cfg.audience));
    let res: Response;
    try {
      res = await outboundFetch(
        String(cfg.tokenUrl),
        { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(this.tokenTimeout) },
        network,
      );
    } catch (err) {
      throw new UpstreamError(msg('proxy.tokenFetchFailed', { error: (err as Error).message }));
    }
    if (!res.ok) {
      this.logger.warn({ credentialId: cred.id, status: res.status }, 'token endpoint rejected the credential');
      throw new UpstreamError(msg('proxy.tokenEndpointStatus', { status: res.status }), res.status);
    }
    let json: { access_token?: string; expires_in?: number };
    try {
      json = JSON.parse((await readLimited(res, MAX_TOKEN_RESPONSE_BYTES)).text) as typeof json;
    } catch (err) {
      throw new UpstreamError(msg('proxy.tokenFetchFailed', { error: (err as Error).message }));
    }
    if (!json.access_token) throw new UpstreamError(msg('proxy.tokenMissingAccessToken'));
    const expiresIn = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 300;
    return { token: json.access_token, expiresAt: Date.now() + expiresIn * 1000 };
  }
}

import { NotFound, REGISTRY_INVALIDATE_CHANNEL, registryGenerationKey, registrySnapshotKey } from '@mcp-gateway/core';
import type { Db } from '@mcp-gateway/db';
import type { Redis } from 'ioredis';
import type { Logger } from '../logger';
import type { Repos } from '../services';
import { buildSnapshot, type RegistrySnapshot } from './snapshot';

interface Entry {
  snapshot: RegistrySnapshot;
  expiresAt: number;
}

export interface RegistryCacheOptions {
  /** Snapshot TTL in Redis (safety net in case an invalidation is lost). */
  redisTtlSeconds?: number;
  /** TTL of the local in-memory cache. */
  localTtlMs?: number;
}

/**
 * Data plane registry cache.
 *
 * L1 in memory per process, L2 in Redis (`registry:snapshot:{tenantId}`) and the source of
 * truth in Postgres. Every control plane mutation calls `invalidate(tenantId)`, which deletes
 * L2 and publishes on `registry:invalidate`. Every replica drops its L1 on receipt.
 */
export class RegistryCache {
  private readonly local = new Map<string, Entry>();
  private readonly slugToId = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<RegistrySnapshot>>();
  private subscriber?: Redis;
  private readonly redisTtl: number;
  private readonly localTtl: number;
  private readonly listeners = new Set<(tenantId: string) => void>();

  constructor(
    private readonly db: Db,
    private readonly repos: Repos,
    private readonly redis: Redis,
    private readonly logger: Logger,
    opts: RegistryCacheOptions = {},
  ) {
    this.redisTtl = opts.redisTtlSeconds ?? 300;
    this.localTtl = opts.localTtlMs ?? 30_000;
  }

  /** Subscribes to the invalidation channel. Uses a dedicated connection (subscriber mode). */
  async start(): Promise<void> {
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('message', (_channel: string, tenantId: string) => this.dropLocal(tenantId));
    await this.subscriber.subscribe(REGISTRY_INVALIDATE_CHANNEL);
  }

  async stop(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.unsubscribe().catch(() => undefined);
      this.subscriber.disconnect();
    }
  }

  /** Notifies when a tenant snapshot is invalidated (e.g. `tools/list_changed`). */
  onInvalidate(fn: (tenantId: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private dropLocal(tenantId: string): void {
    this.local.delete(tenantId);
    for (const fn of this.listeners) {
      try {
        fn(tenantId);
      } catch (err) {
        this.logger.warn({ err }, 'invalidation listener failed');
      }
    }
  }

  async invalidate(tenantId: string): Promise<void> {
    this.local.delete(tenantId);
    await this.redis
      .multi()
      .incr(registryGenerationKey(tenantId))
      .del(registrySnapshotKey(tenantId))
      .publish(REGISTRY_INVALIDATE_CHANNEL, tenantId)
      .exec();
  }

  private async generation(tenantId: string): Promise<number> {
    return Number((await this.redis.get(registryGenerationKey(tenantId))) ?? 0);
  }

  async resolveTenantId(slug: string): Promise<string> {
    const cached = this.slugToId.get(slug);
    if (cached) return cached;
    const t = await this.repos.tenants.findBySlug(slug);
    if (!t) throw new NotFound('tenant', slug);
    this.slugToId.set(slug, t.id);
    return t.id;
  }

  async getBySlug(slug: string): Promise<RegistrySnapshot> {
    return this.get(await this.resolveTenantId(slug));
  }

  async get(tenantId: string): Promise<RegistrySnapshot> {
    const hit = this.local.get(tenantId);
    if (hit && hit.expiresAt > Date.now()) return hit.snapshot;
    const pending = this.inflight.get(tenantId);
    if (pending) return pending;
    const p = this.load(tenantId).finally(() => this.inflight.delete(tenantId));
    this.inflight.set(tenantId, p);
    return p;
  }

  private async load(tenantId: string): Promise<RegistrySnapshot> {
    const key = registrySnapshotKey(tenantId);
    const gen = await this.generation(tenantId);
    const raw = await this.redis.get(key);
    const cached = raw ? (JSON.parse(raw) as RegistrySnapshot) : undefined;
    if (cached && cached.generation === gen) {
      this.local.set(tenantId, { snapshot: cached, expiresAt: Date.now() + this.localTtl });
      return cached;
    }
    const snapshot = await buildSnapshot(this.db, this.repos, tenantId, gen);
    // If an invalidation happened while building, don't cache (the snapshot may be stale).
    if ((await this.generation(tenantId)) === gen) {
      await this.redis.set(key, JSON.stringify(snapshot), 'EX', this.redisTtl);
      this.local.set(tenantId, { snapshot, expiresAt: Date.now() + this.localTtl });
    }
    return snapshot;
  }
}

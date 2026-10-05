import { randomUUID } from 'node:crypto';
import { RateLimited, UpstreamError, type RateLimit } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import type { Redis } from 'ioredis';

/** Sliding window log in a sorted set: atomically drops what left the window, counts and records. */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {0, tonumber(oldest[2]) + window - now}
end
redis.call('ZADD', key, now, ARGV[4])
redis.call('PEXPIRE', key, window)
return {1, 0}
`;

export interface RateLimitCheck {
  scope: string;
  key: string;
  limit: RateLimit | null | undefined;
}

export class RateLimiter {
  constructor(private readonly redis: Redis) {}

  /** Checks every limit; throws `RateLimited` on the first one exceeded. */
  async check(checks: RateLimitCheck[]): Promise<void> {
    const now = Date.now();
    for (const c of checks) {
      if (!c.limit) continue;
      const [allowed, retryAfter] = (await this.redis.eval(
        SLIDING_WINDOW_LUA,
        1,
        `rl:${c.key}`,
        now,
        c.limit.windowSec * 1000,
        c.limit.limit,
        `${now}:${randomUUID()}`,
      )) as [number, number];
      if (!allowed) throw new RateLimited(c.scope, Math.max(retryAfter, 1));
    }
  }
}

export class CircuitOpen extends UpstreamError {
  constructor(sourceName: string, retryAfterMs: number) {
    super(msg('proxy.circuitOpen', { source: sourceName, seconds: Math.ceil(retryAfterMs / 1000) }), undefined, {
      circuit: 'open',
      retryAfterMs,
    });
  }
}

interface CircuitState {
  failures: number[];
  openedAt: number | null;
  probing: boolean;
}

export interface CircuitConfig {
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
}

/**
 * Per-source circuit breaker (per-process state). Opens after `failureThreshold`
 * failures (network, timeout, 5xx) within `windowMs`. After `cooldownMs`, lets one
 * probe request through (half-open).
 */
export class CircuitBreaker {
  private readonly states = new Map<string, CircuitState>();

  private state(key: string): CircuitState {
    let s = this.states.get(key);
    if (!s) {
      s = { failures: [], openedAt: null, probing: false };
      this.states.set(key, s);
    }
    return s;
  }

  /** Throws `CircuitOpen` if the circuit is open. */
  before(key: string, name: string, cfg: CircuitConfig): void {
    const s = this.state(key);
    if (s.openedAt === null) return;
    const elapsed = Date.now() - s.openedAt;
    if (elapsed < cfg.cooldownMs || s.probing) {
      throw new CircuitOpen(name, Math.max(cfg.cooldownMs - elapsed, 1000));
    }
    s.probing = true; // half-open: this request is the probe
  }

  success(key: string): void {
    const s = this.state(key);
    s.failures = [];
    s.openedAt = null;
    s.probing = false;
  }

  failure(key: string, cfg: CircuitConfig): void {
    const s = this.state(key);
    const now = Date.now();
    if (s.probing) {
      s.openedAt = now;
      s.probing = false;
      return;
    }
    s.failures = s.failures.filter((t) => now - t < cfg.windowMs);
    s.failures.push(now);
    if (s.failures.length >= cfg.failureThreshold) s.openedAt = now;
  }

  isOpen(key: string): boolean {
    return this.states.get(key)?.openedAt != null;
  }
}

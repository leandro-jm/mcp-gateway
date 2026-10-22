import type { Redis } from 'ioredis';

/** Cache of rerank/shortlist decisions (names kept, in order). Failures read as a miss. */
export interface DecisionCache {
  get(key: string): Promise<string[] | undefined>;
  set(key: string, names: string[], ttlSec: number): Promise<void>;
}

export class RedisDecisionCache implements DecisionCache {
  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<string[] | undefined> {
    try {
      const raw = await this.redis.get(key);
      const parsed: unknown = raw ? JSON.parse(raw) : undefined;
      return Array.isArray(parsed) && parsed.every((n) => typeof n === 'string') ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async set(key: string, names: string[], ttlSec: number): Promise<void> {
    if (ttlSec <= 0) return;
    await this.redis.set(key, JSON.stringify(names), 'EX', ttlSec).catch(() => undefined);
  }
}

import { generateDataKey, unwrapDataKey, wrapDataKey } from '@mcp-gateway/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../client';
import { tenants } from '../schema';

/**
 * Per-tenant data keys (envelope encryption). The data key is created on demand,
 * encrypted with the master key and stored in `tenants.data_key_encrypted`. The
 * plaintext version only lives in memory.
 */
export class Keyring {
  private readonly cache = new Map<string, Buffer>();

  constructor(
    private readonly db: Db,
    private readonly masterKey: Buffer,
  ) {}

  async dataKey(tenantId: string): Promise<Buffer> {
    const cached = this.cache.get(tenantId);
    if (cached) return cached;
    let [row] = await this.db
      .select({ wrapped: tenants.dataKeyEncrypted })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!row) throw new Error(`unknown tenant: ${tenantId}`);
    if (!row.wrapped) {
      const wrapped = wrapDataKey(this.masterKey, generateDataKey(), tenantId);
      // Only writes if there is no key yet (race between replicas).
      await this.db
        .update(tenants)
        .set({ dataKeyEncrypted: wrapped })
        .where(and(eq(tenants.id, tenantId), isNull(tenants.dataKeyEncrypted)));
      [row] = await this.db
        .select({ wrapped: tenants.dataKeyEncrypted })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
    }
    const key = unwrapDataKey(this.masterKey, row!.wrapped!, tenantId);
    this.cache.set(tenantId, key);
    return key;
  }
}

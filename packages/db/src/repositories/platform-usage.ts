import { sql } from 'drizzle-orm';
import type { Db } from '../client';

export interface TenantUsage {
  tenantId: string;
  slug: string;
  calls: number;
  errors: number;
  responseTokens: number;
  tokensSaved: number;
}

/**
 * Usage of every tenant (platform admin chargeback, F15.12). Read-only, only behind the
 * platform-admin check. @cross-tenant
 */
export class PlatformUsageQueries {
  constructor(private readonly db: Db) {}

  async byTenant(from: Date, to: Date): Promise<TenantUsage[]> {
    const res = await this.db.execute<Record<string, string | number>>(sql`
      SELECT r.tenant_id, t.slug,
             coalesce(sum(r.calls) FILTER (WHERE r.kind = 'tool'), 0) AS calls,
             coalesce(sum(r.calls) FILTER (WHERE r.kind = 'tool' AND r.decision = 'error'), 0) AS errors,
             coalesce(sum(r.response_tokens_sum) FILTER (WHERE r.kind <> 'composite_step'), 0) AS tokens,
             coalesce(sum(r.tokens_saved_projection_sum + r.tokens_saved_artifact_sum + r.tokens_saved_omni_sum), 0) AS saved
      FROM call_rollups_hourly r JOIN tenants t ON t.id = r.tenant_id
      WHERE r.bucket >= date_trunc('hour', ${from}::timestamptz) AND r.bucket < ${to}
      GROUP BY r.tenant_id, t.slug ORDER BY calls DESC`);
    return res.rows.map((r) => ({
      tenantId: String(r.tenant_id),
      slug: String(r.slug),
      calls: Number(r.calls),
      errors: Number(r.errors),
      responseTokens: Number(r.tokens),
      tokensSaved: Number(r.saved),
    }));
  }
}

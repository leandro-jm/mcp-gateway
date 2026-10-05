import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../client';
import { auditEvents, type JsonObject } from '../schema';
import { pageLimit, pageOffset, type PageOpts } from './util';

export type AuditEvent = typeof auditEvents.$inferSelect;
export type AuditInput = Omit<typeof auditEvents.$inferInsert, 'id' | 'ts' | 'tenantId'> & { details?: JsonObject };

export interface AuditFilter extends PageOpts {
  action?: string;
  toolId?: string;
  toolName?: string;
  clientId?: string;
  subject?: string;
  decision?: string;
  from?: Date;
  to?: Date;
}

/** Sanitization applied before writing (e.g. PII redaction in subject/details). */
export type AuditSanitizer = (event: AuditInput) => AuditInput;

export class AuditRepo {
  constructor(
    private readonly db: Db,
    private readonly sanitize: AuditSanitizer = (e) => e,
  ) {}

  async record(tenantId: string | null, event: AuditInput): Promise<void> {
    await this.db.insert(auditEvents).values({ ...this.sanitize(event), tenantId });
  }

  async count(tenantId: string, f: AuditFilter = {}): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(auditEvents).where(and(...this.conds(tenantId, f)));
    return row?.n ?? 0;
  }

  private conds(tenantId: string, f: AuditFilter): SQL[] {
    const conds: SQL[] = [eq(auditEvents.tenantId, tenantId)];
    if (f.action) conds.push(eq(auditEvents.action, f.action));
    if (f.toolId) conds.push(eq(auditEvents.toolId, f.toolId));
    if (f.toolName) conds.push(eq(auditEvents.toolName, f.toolName));
    if (f.clientId) conds.push(eq(auditEvents.clientId, f.clientId));
    if (f.subject) conds.push(eq(auditEvents.subject, f.subject));
    if (f.decision) conds.push(eq(auditEvents.decision, f.decision));
    if (f.from) conds.push(gte(auditEvents.ts, f.from));
    if (f.to) conds.push(lte(auditEvents.ts, f.to));
    return conds;
  }

  async list(tenantId: string, f: AuditFilter = {}): Promise<AuditEvent[]> {
    return this.db
      .select()
      .from(auditEvents)
      .where(and(...this.conds(tenantId, f)))
      .orderBy(desc(auditEvents.ts), desc(auditEvents.id))
      .limit(pageLimit(f))
      .offset(pageOffset(f));
  }
}

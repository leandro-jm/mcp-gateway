import { hashPassword, hashToken } from '@mcp-gateway/core';
import { and, eq } from 'drizzle-orm';
import type { Db } from './client';
import { AuthQueries } from './repositories/auth';
import { apiTokens, tenants, upstreamSources } from './schema';
import type { Locale } from '@mcp-gateway/i18n';

/** Fixed token of the development agent (dev seed only; the value is referenced by the docs). */
export const DEV_AGENT_TOKEN = 'mgw_dev-agent-token-somente-para-desenvolvimento';

export interface SeedOptions {
  upstreamUrl?: string;
}

export interface SeedResult {
  tenantId: string;
  sourceId: string;
  agentToken: string;
}

/**
 * Development seed (idempotent): tenant `dev`, source `rh` pointing to the fake upstream
 * and the dev users (ADR-011): `admin/admin` (platform), `owner/owner`, `owner-pt/owner-pt`,
 * `owner-es/owner-es`, `agente/agente` and the service user `agent-dev` with the `DEV_AGENT_TOKEN` token.
 */
export async function seedDev(db: Db, opts: SeedOptions = {}): Promise<SeedResult> {
  const upstreamUrl = (opts.upstreamUrl ?? 'http://localhost:4010').replace(/\/$/, '');
  const base = await seedTenantAndSource(db, upstreamUrl);
  await seedUsers(db, base.tenantId);
  return { ...base, agentToken: DEV_AGENT_TOKEN };
}

async function seedUsers(db: Db, tenantId: string): Promise<void> {
  const auth = new AuthQueries(db);
  const devUsers: Array<{ tenantId: string | null; username: string; password: string | null; displayName: string; roles: string[]; groups: string[]; locale?: Locale }> = [
    { tenantId: null, username: 'admin', password: 'admin', displayName: 'Admin', roles: ['gateway-admin'], groups: [] },
    { tenantId, username: 'owner', password: 'owner', displayName: 'Owner RH', roles: ['tool-owner'], groups: ['team-rh'] },
    // same as `owner`, with another language (ADR-012)
    { tenantId, username: 'owner-pt', password: 'owner-pt', displayName: 'Owner RH (pt-BR)', roles: ['tool-owner'], groups: ['team-rh'], locale: 'pt-BR' },
    { tenantId, username: 'owner-es', password: 'owner-es', displayName: 'Owner RH (es)', roles: ['tool-owner'], groups: ['team-rh'], locale: 'es' },
    { tenantId, username: 'agente', password: 'agente', displayName: 'Agent', roles: ['agent'], groups: [] },
    { tenantId, username: 'agent-dev', password: null, displayName: 'Dev agent', roles: ['agent'], groups: [] },
  ];
  for (const { tenantId: t, password, ...u } of devUsers) {
    if (await auth.findUser(u.username)) continue;
    await auth.createUser(t, {
      ...u,
      kind: password ? 'human' : 'service',
      passwordHash: password ? await hashPassword(password) : null,
    });
  }
  const agent = await auth.findUser('agent-dev');
  await db
    .insert(apiTokens)
    .values({ userId: agent!.id, name: 'agent-dev', tokenHash: hashToken(DEV_AGENT_TOKEN), prefix: DEV_AGENT_TOKEN.slice(0, 10) })
    .onConflictDoNothing({ target: apiTokens.tokenHash });
}

async function seedTenantAndSource(db: Db, upstreamUrl: string): Promise<Omit<SeedResult, 'agentToken'>> {
  return db.transaction(async (tx) => {
    await tx
      .insert(tenants)
      .values({ slug: 'dev', name: 'Development tenant' })
      .onConflictDoNothing({ target: tenants.slug });
    const [tenant] = await tx.select().from(tenants).where(eq(tenants.slug, 'dev'));
    if (!tenant) throw new Error('seed: tenant dev not found');

    await tx
      .insert(upstreamSources)
      .values({
        tenantId: tenant.id,
        name: 'rh',
        openapiUrl: `${upstreamUrl}/openapi.json`,
        baseUrl: upstreamUrl,
        ownerTeam: 'team-rh',
        crawlSchedule: null,
      })
      .onConflictDoNothing();
    const [source] = await tx
      .select()
      .from(upstreamSources)
      .where(and(eq(upstreamSources.tenantId, tenant.id), eq(upstreamSources.name, 'rh')));
    if (!source) throw new Error('seed: source rh not found');
    return { tenantId: tenant.id, sourceId: source.id };
  });
}

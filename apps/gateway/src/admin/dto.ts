import { applyOverrides } from '@mcp-gateway/core';
import type { ApiToken, CrawlRun, CredentialView, Policy, Source, Tenant, Tool, ToolVersion, User, VirtualServer } from '@mcp-gateway/db';
import { isMessage, type Locale, type Params } from '@mcp-gateway/i18n';
import { translate, type ServerMessage, type ServerMessageKey } from '@mcp-gateway/i18n/server';

const iso = (d: Date) => d.toISOString();
const isoN = (d: Date | null) => (d ? d.toISOString() : null);

export const tenantDto = (t: Tenant) => ({ ...t, createdAt: iso(t.createdAt), updatedAt: iso(t.updatedAt) });

export const credentialDto = (c: CredentialView) => ({
  id: c.id,
  name: c.name,
  type: c.type,
  config: c.config,
  rotatedAt: isoN(c.rotatedAt),
  createdAt: iso(c.createdAt),
  updatedAt: iso(c.updatedAt),
});

export const sourceDto = (s: Source) => ({
  id: s.id,
  name: s.name,
  openapiUrl: s.openapiUrl,
  hasInlineSpec: s.openapiInline !== null,
  specFormat: s.specFormat,
  importMeta: s.importMeta,
  baseUrl: s.baseUrl,
  credentialId: s.credentialId,
  crawlSchedule: s.crawlSchedule,
  ownerTeam: s.ownerTeam,
  status: s.status,
  settings: s.settings,
  lastCrawlAt: isoN(s.lastCrawlAt),
  createdAt: iso(s.createdAt),
  updatedAt: iso(s.updatedAt),
});

/** Crawl error in the user's locale: `errorKey` + `errorParams` when present, else the stored (English) text. */
function crawlError(r: CrawlRun, locale: Locale): string | null {
  if (!r.errorKey) return r.error;
  return translate({ key: r.errorKey as ServerMessageKey, ...(r.errorParams ? { params: r.errorParams as Params } : {}) }, locale);
}

export const crawlRunDto = (r: CrawlRun, locale: Locale) => ({
  id: r.id,
  sourceId: r.sourceId,
  status: r.status,
  trigger: r.trigger,
  startedAt: isoN(r.startedAt),
  finishedAt: isoN(r.finishedAt),
  stats: r.stats,
  error: crawlError(r, locale),
  createdAt: iso(r.createdAt),
});

/**
 * Renders composite validation issues in `locale`. Issues carry a `Message` (ADR-012); legacy rows
 * may still hold a plain string `message`, which passes through unchanged.
 */
export function renderIssues(issues: unknown, locale: Locale): Array<{ path: string; message: string }> {
  if (!Array.isArray(issues)) return [];
  return issues.map((issue: { path?: unknown; message?: unknown }) => ({
    path: String(issue?.path ?? ''),
    message: isMessage(issue?.message) ? translate(issue.message as ServerMessage, locale) : String(issue?.message ?? ''),
  }));
}

export const toolDto = (t: Tool) => {
  const eff = applyOverrides(t);
  return {
    id: t.id,
    kind: t.kind,
    sourceId: t.sourceId,
    name: eff.name,
    baseName: eff.baseName,
    title: eff.title,
    description: eff.description,
    operationRef: t.operationRef,
    inputSchema: eff.inputSchema,
    outputSchema: t.outputSchema,
    annotations: t.annotations,
    state: t.state,
    specHash: t.specHash,
    version: t.version,
    ownerTeam: t.ownerTeam,
    overrides: t.overrides,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  };
};

export const toolVersionDto = (v: ToolVersion) => ({
  version: v.version,
  specHash: v.specHash,
  inputSchema: v.inputSchema,
  outputSchema: v.outputSchema,
  diff: v.diff,
  createdAt: iso(v.createdAt),
});

export const virtualServerDto = (v: VirtualServer, publicUrl: string) => ({
  id: v.id,
  slug: v.slug,
  name: v.name,
  description: v.description,
  instructions: v.instructions,
  toolSelector: v.toolSelector,
  mode: v.mode,
  icon: v.icon,
  metadata: v.metadata,
  ownerTeam: v.ownerTeam,
  endpoints: {
    mcp: `${publicUrl.replace(/\/$/, '')}/mcp/s/${v.slug}`,
    omni: `${publicUrl.replace(/\/$/, '')}/mcp/s/${v.slug}/omni`,
  },
  createdAt: iso(v.createdAt),
  updatedAt: iso(v.updatedAt),
});

export const policyDto = (p: Policy) => ({
  id: p.id,
  subjectType: p.subjectType,
  subject: p.subject,
  effect: p.effect,
  toolPattern: p.toolPattern,
  conditions: p.conditions,
  priority: p.priority,
  description: p.description,
  createdAt: iso(p.createdAt),
  updatedAt: iso(p.updatedAt),
});

export const userDto = (u: User) => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  kind: u.kind,
  roles: u.roles,
  groups: u.groups,
  attributes: u.attributes,
  status: u.status,
  locale: u.locale,
  hasPassword: u.hasPassword,
  createdAt: iso(u.createdAt),
  updatedAt: iso(u.updatedAt),
});

export const apiTokenDto = (t: ApiToken) => ({
  id: t.id,
  name: t.name,
  prefix: t.prefix,
  expiresAt: isoN(t.expiresAt),
  lastUsedAt: isoN(t.lastUsedAt),
  createdAt: iso(t.createdAt),
});

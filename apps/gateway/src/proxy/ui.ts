import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Locale } from '@mcp-gateway/i18n';
import { msg, translate } from '@mcp-gateway/i18n/server';
import { MCP_APPS_EXTENSION, META_KEYS, resourceFor, type ToolViews, type ViewPayload, type ViewResource } from '@mcp-ui-kit/view-spec';
import type { RegistrySnapshot } from '../registry/snapshot';
import type { CallContext, McpClientInfo } from './executor';

/** The generic MCP Apps served by the gateway (ADR-022). */
export const UI_RESOURCES: Record<ViewResource, string> = {
  view: 'ui://mcp-gateway/view',
  map: 'ui://mcp-gateway/map',
  diagram: 'ui://mcp-gateway/diagram',
};

export const UI_META = META_KEYS;

/**
 * Whether the views of a tool should be advertised to this client: a 2026-07-28 client that
 * declared MCP Apps, or a 2025-era client (its `initialize` is not visible to a stateless
 * request, and clients without MCP Apps ignore unknown `_meta`). Gateway-internal calls (the
 * Playground, composites) have no MCP client and get no UI.
 */
export function clientHasUi(client: McpClientInfo | undefined): boolean {
  if (!client) return false;
  return client.era === 'legacy' || client.extensions.includes(MCP_APPS_EXTENSION);
}

/** Active views of a tool in this snapshot (already validated against the tool contract). */
export function activeViews(snapshot: RegistrySnapshot, toolId: string): ToolViews | undefined {
  return (snapshot.toolViews ?? []).find((v) => v.toolId === toolId)?.views;
}

/** `_meta` of a tool descriptor pointing at its MCP App (plus the ChatGPT Apps SDK alias). */
export function descriptorUiMeta(views: ToolViews): Record<string, unknown> {
  const uri = UI_RESOURCES[resourceFor(views)];
  return { ui: { resourceUri: uri }, 'openai/outputTemplate': uri };
}

/** `_meta` of a tool result carrying the view payload and the tenant's branding. */
export function resultUiMeta(snapshot: RegistrySnapshot, payload: ViewPayload): Record<string, unknown> {
  const theme = snapshot.theme;
  const full: ViewPayload = theme?.tileUrl && payload.views.result?.kind === 'map'
    ? { ...payload, mapTiles: { url: theme.tileUrl, ...(theme.tileAttribution ? { attribution: theme.tileAttribution } : {}) } }
    : payload;
  return { [META_KEYS.views]: full, ...(theme && Object.keys(theme.tokens).length ? { [META_KEYS.theme]: theme.tokens } : {}) };
}

/** Host of the tenant basemap, for the `map` resource CSP. */
export function tileHost(snapshot: RegistrySnapshot): string | undefined {
  const url = snapshot.theme?.tileUrl;
  if (!url) return undefined;
  try {
    const u = new URL(url.replace(/\{[a-z]\}/gi, '0'));
    return u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/** UI hints a request carried in `params._meta` (set by a view; self-declared). */
export function uiRequestOf(meta: unknown): CallContext['ui'] {
  if (!meta || typeof meta !== 'object') return undefined;
  const m = meta as Record<string, unknown>;
  const token = m[META_KEYS.confirm];
  const origin = m[META_KEYS.origin];
  if (typeof token !== 'string' && origin !== 'app') return undefined;
  return { ...(typeof token === 'string' && token.length <= 512 ? { confirmToken: token } : {}), ...(origin === 'app' ? { origin: 'app' as const } : {}) };
}

/**
 * Field errors for the form view from the argument validator details (Ajv). Messages come from
 * the gateway catalog (localized), never from the library.
 */
export function fieldErrors(details: unknown, locale: Locale): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(details)) return out;
  for (const d of details as Array<{ path?: string; message?: string; field?: string }>) {
    const required = /required property '([^']+)'/.exec(d.message ?? '');
    const field = required?.[1] ?? d.field ?? (d.path ?? '').split('/').filter(Boolean)[0];
    if (!field || out[field]) continue;
    out[field] = translate(msg(required ? 'ui.fieldRequired' : 'ui.fieldInvalid'), locale);
  }
  return out;
}

const TOKEN_TTL_MS = 10 * 60_000;

/**
 * One-time confirmation tokens for destructive calls (ADR-022). The token is an HMAC (tenant key,
 * domain-separated) over tenant, subject, tool and expiry; it only travels in result/request
 * `_meta`, so the model never sees it. Used nonces are kept in memory until they expire.
 */
export class ConfirmTokens {
  private readonly used = new Map<string, number>();

  constructor(private readonly keyOf: (tenantId: string) => Promise<Buffer>) {}

  private async sign(tenantId: string, body: string): Promise<string> {
    const key = await this.keyOf(tenantId);
    return createHmac('sha256', key).update(`ui-confirm:v1:${body}`).digest('base64url');
  }

  async issue(ctx: CallContext, tool: string): Promise<string> {
    const body = Buffer.from(JSON.stringify({ t: ctx.tenantId, s: ctx.principal.sub, n: tool, e: Date.now() + TOKEN_TTL_MS, r: randomBytes(9).toString('base64url') })).toString('base64url');
    return `${body}.${await this.sign(ctx.tenantId, body)}`;
  }

  /** True once per valid token: right tenant, subject and tool, not expired, not used before. */
  async consume(ctx: CallContext, tool: string, token: string): Promise<boolean> {
    const [body, sig] = token.split('.');
    if (!body || !sig) return false;
    const expected = Buffer.from(await this.sign(ctx.tenantId, body));
    const got = Buffer.from(sig);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return false;
    let claims: { t?: string; s?: string; n?: string; e?: number; r?: string };
    try {
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return false;
    }
    const now = Date.now();
    if (claims.t !== ctx.tenantId || claims.s !== ctx.principal.sub || claims.n !== tool || typeof claims.e !== 'number' || claims.e < now) return false;
    this.sweep(now);
    if (!claims.r || this.used.has(claims.r)) return false;
    this.used.set(claims.r, claims.e);
    return true;
  }

  private sweep(now: number): void {
    if (this.used.size < 1000) return;
    for (const [k, exp] of this.used) if (exp < now) this.used.delete(k);
  }
}

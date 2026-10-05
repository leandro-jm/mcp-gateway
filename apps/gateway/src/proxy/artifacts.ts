import { randomUUID } from 'node:crypto';
import { ArtifactStore } from '@mcp-gateway/artifacts';
import { NotFound, readArtifactSettings, readTrafficSettings, ValidationError } from '@mcp-gateway/core';
import type { Artifact, ArtifactsRepo, SystemQueries } from '@mcp-gateway/db';
import { DEFAULT_LOCALE, type Locale } from '@mcp-gateway/i18n';
import { msg, translate } from '@mcp-gateway/i18n/server';
import { bytesOf, selectValues, isValidSelector } from '@mcp-gateway/projection';
import jsonata from 'jsonata';
import type { Logger } from '../logger';
import type { CallContext } from './executor';
import { JsonataSandbox } from './jsonata-sandbox';
import type { ToolResult } from './result';

export const ARTIFACT_SCHEME = 'artifact://';
const MAX_QUERY_RESULT = 64 * 1024;
const MAX_PREVIEW_BYTES = 1200;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Records of a response: the root array or the main list of objects in the envelope. */
export function recordsOf(data: unknown): { path: string; records: unknown[] } | undefined {
  if (Array.isArray(data)) return { path: '$', records: data };
  if (isObj(data)) {
    const key = Object.keys(data).find((k) => Array.isArray(data[k]) && (data[k] as unknown[]).some(isObj));
    if (key) return { path: `$.${key}`, records: data[key] as unknown[] };
  }
  return undefined;
}

const typeName = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' && Number.isInteger(v) ? 'integer' : typeof v);

/** Schema summary: fields and types of the records (and scalars of the envelope). */
export function schemaSummary(data: unknown): Record<string, unknown> {
  const rec = recordsOf(data);
  const out: Record<string, unknown> = {};
  if (isObj(data)) for (const [k, v] of Object.entries(data)) if (!Array.isArray(v) && !isObj(v)) out[k] = typeName(v);
  if (rec) {
    const fields: Record<string, Set<string>> = {};
    for (const r of rec.records.slice(0, 50)) {
      if (!isObj(r)) continue;
      for (const [k, v] of Object.entries(r)) (fields[k] ??= new Set()).add(typeName(v));
    }
    out[`${rec.path}[]`] = Object.fromEntries(Object.entries(fields).map(([k, t]) => [k, [...t].join('|')]));
  } else if (isObj(data)) {
    for (const [k, v] of Object.entries(data)) if (Array.isArray(v) || isObj(v)) out[k] = typeName(v);
  }
  return out;
}

function compactRecord(r: unknown): unknown {
  if (!isObj(r)) return typeof r === 'string' && r.length > 80 ? `${r.slice(0, 79)}…` : r;
  return Object.fromEntries(
    Object.entries(r)
      .filter(([, v]) => !isObj(v) && !Array.isArray(v))
      .slice(0, 12)
      .map(([k, v]) => [k, typeof v === 'string' && v.length > 80 ? `${v.slice(0, 79)}…` : v]),
  );
}

/** First records, compacted until they fit in ~1.2 KB. */
export function previewOf(data: unknown, n: number): unknown[] {
  const rec = recordsOf(data);
  let items = (rec ? rec.records : [data]).slice(0, n).map(compactRecord);
  while (items.length > 1 && bytesOf(items) > MAX_PREVIEW_BYTES) items = items.slice(0, -1);
  return bytesOf(items) > MAX_PREVIEW_BYTES ? [] : items;
}

export interface ArtifactContext {
  tenantId: string;
  sessionKey: string;
  snapshot: CallContext['snapshot'];
  /** Locale of the texts returned to the agent (the principal's locale). */
  locale?: Locale;
}

/** Artifacts (F8): offload of large responses, reading, querying and inputs by reference. */
export class ArtifactService {
  constructor(
    private readonly repo: ArtifactsRepo,
    private readonly logger: Logger,
    private readonly store?: ArtifactStore,
    private readonly sandbox = new JsonataSandbox({ maxResultBytes: MAX_QUERY_RESULT }),
  ) {}

  get enabled(): boolean {
    return Boolean(this.store);
  }

  async init(): Promise<void> {
    await this.store?.ensureBucket();
  }

  shouldOffload(ctx: ArtifactContext, size: number, forced: boolean): boolean {
    if (!this.store) return false;
    return forced || size > readArtifactSettings(ctx.snapshot.tenant.settings).thresholdBytes;
  }

  /** Stores the (already redacted/projected) response and returns the summarized result for the agent. */
  async offload(ctx: ArtifactContext, toolName: string, callId: string, data: unknown): Promise<{ result: ToolResult; artifact: Artifact }> {
    if (!this.store) throw new ValidationError(msg('proxy.artifactsDisabled'));
    const locale = ctx.locale ?? DEFAULT_LOCALE;
    const settings = readArtifactSettings(ctx.snapshot.tenant.settings);
    const body = JSON.stringify(data);
    const size = Buffer.byteLength(body);
    if (size > settings.maxBytes) throw new ValidationError(msg('proxy.artifactTooLarge', { max: settings.maxBytes }));
    const id = randomUUID();
    const objectKey = ArtifactStore.key(ctx.tenantId, ctx.sessionKey, callId);
    await this.store.put(objectKey, body);
    const rec = recordsOf(data);
    const summary = schemaSummary(data);
    const artifact = await this.repo.create(ctx.tenantId, {
      id,
      sessionId: ctx.sessionKey,
      toolCallId: callId,
      toolName,
      uri: `${ARTIFACT_SCHEME}${id}`,
      objectKey,
      sizeBytes: size,
      rowCount: rec?.records.length ?? null,
      schemaSummary: summary,
      expiresAt: new Date(Date.now() + settings.ttlSeconds * 1000),
    });
    const payload = {
      artifact_uri: artifact.uri,
      size_bytes: size,
      row_count: artifact.rowCount,
      ...(rec ? { records_path: rec.path } : {}),
      schema_summary: summary,
      preview: previewOf(data, settings.previewItems),
      expires_at: artifact.expiresAt.toISOString(),
      hint: translate(msg('proxy.artifactOffloadHint'), locale),
    };
    return {
      artifact,
      result: {
        // `structuredContent` is required when the tool has an output schema; the advertised schema is relaxed (accepts the summary).
        structuredContent: payload,
        content: [
          { type: 'text', text: JSON.stringify(payload) },
          {
            type: 'resource_link',
            uri: artifact.uri,
            name: `${toolName}-${id.slice(0, 8)}.json`,
            mimeType: 'application/json',
            description: translate(
              artifact.rowCount !== null
                ? msg('proxy.artifactLinkDescriptionRows', { tool: toolName, rows: artifact.rowCount })
                : msg('proxy.artifactLinkDescription', { tool: toolName }),
              locale,
            ),
          },
        ],
      },
    };
  }

  private parseUri(uri: string): string {
    if (typeof uri !== 'string' || !uri.startsWith(ARTIFACT_SCHEME)) throw new ValidationError(msg('proxy.artifactInvalidUriScheme'));
    const id = uri.slice(ARTIFACT_SCHEME.length);
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new ValidationError(msg('proxy.artifactInvalidUri'));
    return id;
  }

  async load(ctx: ArtifactContext, uri: string): Promise<{ artifact: Artifact; data: unknown }> {
    if (!this.store) throw new ValidationError(msg('proxy.artifactsDisabled'));
    let artifact: Artifact;
    try {
      artifact = await this.repo.getOwned(ctx.tenantId, ctx.sessionKey, this.parseUri(uri));
    } catch (err) {
      if (err instanceof NotFound) throw new ValidationError(msg('proxy.artifactNotFound'));
      throw err;
    }
    const text = await this.store.getText(artifact.objectKey);
    return { artifact, data: JSON.parse(text) };
  }

  async read(ctx: ArtifactContext, uri: string, offset = 0, limit = 50): Promise<Record<string, unknown>> {
    const { artifact, data } = await this.load(ctx, uri);
    const lim = Math.min(Math.max(limit, 1), 500);
    const off = Math.max(offset, 0);
    const rec = recordsOf(data);
    if (rec) {
      return { uri: artifact.uri, path: rec.path, total: rec.records.length, offset: off, limit: lim, items: rec.records.slice(off, off + lim) };
    }
    const text = JSON.stringify(data);
    const chunk = lim * 200; // ~200 bytes per "record" for non-tabular content
    return { uri: artifact.uri, total_bytes: Buffer.byteLength(text), offset: off, text: text.slice(off, off + chunk) };
  }

  async query(ctx: ArtifactContext, uri: string, expression: string): Promise<unknown> {
    const { data } = await this.load(ctx, uri);
    try {
      jsonata(expression); // syntax check only: evaluation runs isolated in a worker (ADR-013)
    } catch (err) {
      throw new ValidationError(msg('proxy.artifactInvalidJsonata', { error: (err as Error).message }));
    }
    const out = await this.sandbox.evaluate(expression, data);
    switch (out.kind) {
      case 'ok':
        return out.value;
      case 'timeout':
        throw new ValidationError(msg('proxy.artifactQueryTimeout', { seconds: 5 }));
      case 'too_large':
        throw new ValidationError(msg('proxy.artifactQueryResultTooLarge'));
      case 'resources':
        throw new ValidationError(msg('proxy.artifactQueryResourceLimit'));
      case 'busy':
        throw new ValidationError(msg('proxy.artifactQueryBusy'));
      case 'error':
        throw new ValidationError(msg('proxy.artifactQueryFailed', { error: out.message }));
    }
  }

  async list(ctx: ArtifactContext): Promise<Artifact[]> {
    return this.store ? this.repo.listBySession(ctx.tenantId, ctx.sessionKey) : [];
  }

  /**
   * Inputs by reference (F8.4): `{ "$artifact": "artifact://…", "path": "$.items[*].id" }`
   * anywhere in the arguments becomes the selected value.
   */
  async resolveRefs(ctx: ArtifactContext, args: Record<string, unknown>): Promise<{ args: Record<string, unknown>; resolved: number }> {
    let resolved = 0;
    const cache = new Map<string, unknown>();
    const walk = async (v: unknown): Promise<unknown> => {
      if (Array.isArray(v)) return Promise.all(v.map(walk));
      if (!isObj(v)) return v;
      if (typeof v.$artifact === 'string') {
        const path = typeof v.path === 'string' ? v.path : '$';
        if (!isValidSelector(path)) throw new ValidationError(msg('proxy.artifactInvalidRefPath', { path }));
        if (!cache.has(v.$artifact)) cache.set(v.$artifact, (await this.load(ctx, v.$artifact)).data);
        resolved += 1;
        return selectValues(cache.get(v.$artifact), path);
      }
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = await walk(x);
      return out;
    };
    const out = (await walk(args)) as Record<string, unknown>;
    if (resolved) {
      const max = readTrafficSettings(ctx.snapshot.tenant.settings).limits.maxRequestBytes;
      if (bytesOf(out) > max) throw new ValidationError(msg('proxy.artifactResolvedArgsTooLarge', { max }));
    }
    return { args: out, resolved };
  }

  /** Periodic cleanup (F8.1): expired objects and rows. */
  async cleanup(system: SystemQueries): Promise<number> {
    if (!this.store) return 0;
    let total = 0;
    for (;;) {
      const expired = await system.expiredArtifacts(500);
      if (!expired.length) return total;
      await this.store.deleteMany(expired.map((e) => e.objectKey));
      await system.deleteArtifactRows(expired.map((e) => e.id));
      total += expired.length;
      this.logger.info({ count: expired.length }, 'expired artifacts removed');
      if (expired.length < 500) return total;
    }
  }

  async ping(): Promise<void> {
    await this.store?.ping();
  }

  close(): void {
    this.store?.close();
  }
}

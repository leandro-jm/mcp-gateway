import { createHmac } from 'node:crypto';
import { decrypt, encrypt, isSafeRegex, readObservabilitySettings, readPiiSettings, ValidationError } from '@mcp-gateway/core';
import type { Keyring, PiiTokensRepo } from '@mcp-gateway/db';
import type { Locale } from '@mcp-gateway/i18n';
import { msg } from '@mcp-gateway/i18n/server';
import {
  bankAccountDetector,
  detectFieldName,
  matchesSelector,
  redact,
  redactText,
  scanIdentifiers,
  VALUE_DETECTORS,
  withSynonyms,
  type FingerprintOptions,
  type PathSeg,
  type PiiRule,
  type RedactOptions,
  type RedactResult,
  type SubjectFingerprint,
  type TokenRecord,
} from '@mcp-gateway/redaction';
import type { RegistrySnapshot, SnapshotTool } from '../registry/snapshot';

const TOKEN_EXACT = /^pii_tok_[a-f0-9]{24}$/;

export interface PiiContext {
  tenantId: string;
  snapshot: RegistrySnapshot;
  /** Locale of the placeholder that replaces dropped PII (default: English). */
  locale?: Locale;
  /** Who sees the response (tokens are bound to it) or sends the arguments (must be one of them). */
  subject?: string;
}

/**
 * PII in the data plane (F5): redaction before any byte reaches the model,
 * vault of reversible tokens and input detokenization.
 */
export class PiiService {
  private readonly keys = new Map<string, Buffer>();

  constructor(
    private readonly keyring: Keyring,
    private readonly tokens: PiiTokensRepo,
  ) {}

  /** Tenant PII HMAC key, derived from the data key (never leaves the gateway). */
  async key(tenantId: string): Promise<Buffer> {
    let k = this.keys.get(tenantId);
    if (!k) {
      k = createHmac('sha256', await this.keyring.dataKey(tenantId)).update('mcp-gateway:pii').digest();
      this.keys.set(tenantId, k);
    }
    return k;
  }

  /**
   * Tenant analytics key (ADR-016): argument hashes for loop detection. Distinct from the PII
   * key, so analytics hashes never match the `pii_h_` values agents see.
   */
  async analyticsKey(tenantId: string): Promise<Buffer> {
    const cacheKey = `analytics:${tenantId}`;
    let k = this.keys.get(cacheKey);
    if (!k) {
      k = createHmac('sha256', await this.keyring.dataKey(tenantId)).update('mcp-gateway:analytics').digest();
      this.keys.set(cacheKey, k);
    }
    return k;
  }

  /**
   * Tenant LGPD subject-index key (ADR-017). Distinct from the PII hash key, so the `pii_h_`
   * values agents see never match the index.
   */
  async subjectKey(tenantId: string): Promise<Buffer> {
    const cacheKey = `subject:${tenantId}`;
    let k = this.keys.get(cacheKey);
    if (!k) {
      k = createHmac('sha256', await this.keyring.dataKey(tenantId)).update('mcp-gateway:subject-index').digest();
      this.keys.set(cacheKey, k);
    }
    return k;
  }

  /** Subject index options of the tenant (`undefined` when it is turned off). */
  async fingerprintOptions(ctx: Pick<PiiContext, 'tenantId' | 'snapshot'>): Promise<FingerprintOptions | undefined> {
    const s = readObservabilitySettings(ctx.snapshot.tenant.settings).subjectIndex;
    if (!s.enabled || !s.detectors.length) return undefined;
    return { key: await this.subjectKey(ctx.tenantId), detectors: new Set(s.detectors), max: s.maxPerCall };
  }

  /** Identifiers in the call arguments (after detokenization): the agent searched for someone. */
  async scanRequest(ctx: PiiContext, args: Record<string, unknown>): Promise<{ fingerprints: SubjectFingerprint[]; truncated: boolean }> {
    const fp = await this.fingerprintOptions(ctx);
    if (!fp) return { fingerprints: [], truncated: false };
    const settings = readPiiSettings(ctx.snapshot.tenant.settings);
    return scanIdentifiers(args, fp, { fieldDetectors: withSynonyms(settings.synonyms) });
  }

  rules(snapshot: RegistrySnapshot): PiiRule[] {
    return snapshot.piiRules.map((r) => ({
      id: r.id,
      scope: r.scope,
      scopeRef: r.scopeRef,
      detector: r.detector,
      fieldSelector: r.fieldSelector,
      strategy: r.strategy,
      direction: r.direction,
    }));
  }

  async options(ctx: PiiContext, tool: Pick<SnapshotTool, 'id' | 'sourceId'>, direction: 'request' | 'response'): Promise<RedactOptions> {
    const settings = readPiiSettings(ctx.snapshot.tenant.settings);
    // patterns saved before the write-time check are ignored rather than risking ReDoS
    const valueDetectors = settings.bankAccountPattern && isSafeRegex(settings.bankAccountPattern)
      ? [...VALUE_DETECTORS, bankAccountDetector(settings.bankAccountPattern)]
      : VALUE_DETECTORS;
    return {
      direction,
      rules: this.rules(ctx.snapshot),
      toolId: tool.id,
      ...(tool.sourceId ? { sourceId: tool.sourceId } : {}),
      key: await this.key(ctx.tenantId),
      fieldDetectors: withSynonyms(settings.synonyms),
      valueDetectors,
      ...(ctx.locale ? { locale: ctx.locale } : {}),
    };
  }

  /** Redacts a response and stores the generated tokens in the vault (optionally collecting subject fingerprints). */
  async redactResponse<T>(ctx: PiiContext, tool: Pick<SnapshotTool, 'id' | 'sourceId'>, value: T, fingerprints?: FingerprintOptions): Promise<RedactResult<T>> {
    const res = redact(value, { ...(await this.options(ctx, tool, 'response')), ...(fingerprints ? { fingerprints } : {}) });
    await this.store(ctx, res.tokens);
    return res;
  }

  /** Version of the arguments that is safe for logs and audit. */
  async redactForLog<T>(ctx: PiiContext, tool: Pick<SnapshotTool, 'id' | 'sourceId'>, value: T): Promise<T> {
    return redact(value, await this.options(ctx, tool, 'request')).value;
  }

  /**
   * Free text that leaves the gateway (tool router query and intent, ADR-025): value detectors
   * only, no tokens stored. Tenant- and source-wide rules still apply; tool rules do not.
   */
  async redactText(ctx: PiiContext, text: string): Promise<string> {
    return redactText(text, await this.options(ctx, { id: '', sourceId: null }, 'request')).value;
  }

  private async store(ctx: PiiContext, records: TokenRecord[]): Promise<void> {
    if (!records.length) return;
    const ttl = readPiiSettings(ctx.snapshot.tenant.settings).tokenTtlSeconds;
    const dataKey = await this.keyring.dataKey(ctx.tenantId);
    const expiresAt = new Date(Date.now() + ttl * 1000);
    await this.tokens.upsert(
      ctx.tenantId,
      records.map((r) => ({
        token: r.token,
        detector: r.detector,
        valueEncrypted: encrypt(dataKey, r.value, `pii:${ctx.tenantId}:${r.token}`),
        subjects: ctx.subject ? [ctx.subject] : [],
        expiresAt,
      })),
    );
  }

  /**
   * Replaces `pii_tok_*` tokens in the arguments with the real value (F5.4). Only accepts
   * tokens of the same tenant, not expired, shown to the same subject, and in fields authorized for the detector:
   * the field name is of that PII type, or there is a tokenization rule (request) of the
   * tool/source for the field.
   */
  async detokenize(ctx: PiiContext, tool: SnapshotTool, args: Record<string, unknown>): Promise<{ args: Record<string, unknown>; count: number }> {
    const found: Array<{ path: PathSeg[]; token: string }> = [];
    const collect = (v: unknown, path: PathSeg[]) => {
      if (typeof v === 'string' && TOKEN_EXACT.test(v)) found.push({ path, token: v });
      else if (Array.isArray(v)) v.forEach((x, i) => collect(x, [...path, i]));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) collect(x, [...path, k]);
    };
    collect(args, []);
    if (!found.length) return { args, count: 0 };

    const rows = new Map((await this.tokens.find(ctx.tenantId, [...new Set(found.map((f) => f.token))])).map((r) => [r.token, r]));
    const settings = readPiiSettings(ctx.snapshot.tenant.settings);
    const detectors = withSynonyms(settings.synonyms);
    const rules = this.rules(ctx.snapshot).filter(
      (r) =>
        r.strategy === 'tokenize' &&
        r.direction !== 'response' &&
        ((r.scope === 'tool' && r.scopeRef === tool.id) || (r.scope === 'source' && r.scopeRef === tool.sourceId)),
    );
    const dataKey = await this.keyring.dataKey(ctx.tenantId);
    const out = structuredClone(args);

    for (const { path, token } of found) {
      const row = rows.get(token);
      // a token only goes back to whoever received it (same answer as an unknown token: no oracle)
      const shown = !row?.subjects.length || (ctx.subject !== undefined && row.subjects.includes(ctx.subject));
      if (!row || !shown) throw new ValidationError(msg('pii.invalidToken'), { field: path.join('.') });
      const field = [...path].reverse().find((p): p is string => typeof p === 'string');
      const byName = field ? detectFieldName(field, detectors)?.id === row.detector : false;
      const byRule = rules.some((r) => r.detector === row.detector && (!r.fieldSelector || matchesSelector(r.fieldSelector, path)));
      if (!byName && !byRule) {
        throw new ValidationError(msg('pii.tokenFieldNotAllowed', { detector: row.detector, field: path.join('.') }), {
          field: path.join('.'),
          detector: row.detector,
        });
      }
      const value = decrypt(dataKey, row.valueEncrypted, `pii:${ctx.tenantId}:${token}`).toString('utf8');
      let target: Record<string | number, unknown> = out as Record<string, unknown>;
      for (const seg of path.slice(0, -1)) target = target[seg] as Record<string | number, unknown>;
      target[path[path.length - 1]!] = value;
    }
    return { args: out, count: found.length };
  }
}

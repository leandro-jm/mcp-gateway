import {
  detectFieldName,
  FIELD_DETECTORS,
  findValueMatches,
  isValidCnpj,
  isValidCpf,
  isValidPis,
  VALUE_DETECTORS,
  type DetectorCategory,
  type FieldDetector,
  type ValueDetector,
} from './detectors';
import type { Locale } from '@mcp-gateway/i18n';
import { msg, translate } from '@mcp-gateway/i18n/server';
import { matchesSelector, type PathSeg } from './paths';
import { hashValue, maskValue, tokenFor, type Strategy } from './strategies';
import { FingerprintCollector, type FingerprintOptions, type SubjectFingerprint } from './subject';

export type Direction = 'request' | 'response';
export type RuleScope = 'global' | 'source' | 'tool';

export interface PiiRule {
  id?: string;
  scope: RuleScope;
  scopeRef?: string | null;
  /** Detector id (cpf, salario…) or `field` for a custom selector. */
  detector: string;
  /** Restricts the rule to paths (field name or reduced JSONPath). Required for `field`. */
  fieldSelector?: string | null;
  strategy: Strategy;
  direction: 'request' | 'response' | 'both';
}

export interface RedactOptions {
  direction: Direction;
  rules: PiiRule[];
  toolId?: string;
  sourceId?: string;
  /** Tenant HMAC key (hash and tokenization). */
  key: Buffer;
  /** Language of the placeholder that replaces dropped PII inside text (default `en`). */
  locale?: Locale;
  fieldDetectors?: FieldDetector[];
  valueDetectors?: ValueDetector[];
  /** LGPD subject index (ADR-017): fingerprint detected identifiers before the strategy applies. */
  fingerprints?: FingerprintOptions;
}

export interface TokenRecord {
  token: string;
  detector: string;
  value: string;
}

export interface RedactResult<T = unknown> {
  value: T;
  count: number;
  byDetector: Record<string, number>;
  tokens: TokenRecord[];
  /** Present when `fingerprints` was requested. */
  fingerprints?: SubjectFingerprint[];
  fingerprintsTruncated?: boolean;
}

const CATEGORY_DEFAULT: Record<DetectorCategory, Strategy> = {
  documento: 'mask',
  contato: 'mask',
  pessoal: 'mask',
  financeiro: 'mask',
  saude: 'drop',
};

/** Tenant default policy (PLAN F5.3): mask for documents, drop for health and salary. */
export function defaultStrategy(detector: string, category: DetectorCategory | undefined): Strategy {
  if (detector === 'salario') return 'drop';
  return category ? CATEGORY_DEFAULT[category] : 'mask';
}

const SCOPE_RANK: Record<RuleScope, number> = { tool: 3, source: 2, global: 1 };

/** Rules applicable to the context, from most to least specific (tool > source > global). */
export function applicableRules(rules: PiiRule[], opts: Pick<RedactOptions, 'direction' | 'toolId' | 'sourceId'>): PiiRule[] {
  return rules
    .filter((r) => r.direction === 'both' || r.direction === opts.direction)
    .filter(
      (r) =>
        r.scope === 'global' ||
        (r.scope === 'source' && r.scopeRef && r.scopeRef === opts.sourceId) ||
        (r.scope === 'tool' && r.scopeRef && r.scopeRef === opts.toolId),
    )
    .sort((a, b) => SCOPE_RANK[b.scope] - SCOPE_RANK[a.scope] || Number(Boolean(b.fieldSelector)) - Number(Boolean(a.fieldSelector)));
}

const DROP = Symbol('drop');

const removedText = (locale?: Locale) => translate(msg('redaction.removed'), locale);

class Redactor {
  count = 0;
  byDetector: Record<string, number> = {};
  tokens = new Map<string, TokenRecord>();
  readonly collector: FingerprintCollector | undefined;
  private readonly fieldDetectors: FieldDetector[];
  private readonly valueDetectors: ValueDetector[];
  private readonly selectorRules: PiiRule[];
  private readonly categories = new Map<string, DetectorCategory>();

  constructor(
    private readonly rules: PiiRule[],
    private readonly opts: RedactOptions,
  ) {
    this.fieldDetectors = opts.fieldDetectors ?? FIELD_DETECTORS;
    this.valueDetectors = opts.valueDetectors ?? VALUE_DETECTORS;
    this.selectorRules = rules.filter((r) => r.detector === 'field' && r.fieldSelector);
    this.collector = opts.fingerprints ? new FingerprintCollector(opts.fingerprints) : undefined;
    for (const d of [...this.fieldDetectors, ...this.valueDetectors]) this.categories.set(d.id, d.category);
  }

  private strategyFor(detector: string, path: PathSeg[]): Strategy {
    const rule = this.rules.find((r) => r.detector === detector && (!r.fieldSelector || matchesSelector(r.fieldSelector, path)));
    return rule?.strategy ?? defaultStrategy(detector, this.categories.get(detector));
  }

  private bump(detector: string): void {
    this.count += 1;
    this.byDetector[detector] = (this.byDetector[detector] ?? 0) + 1;
  }

  private transform(detector: string, strategy: Strategy, raw: unknown): unknown | typeof DROP {
    this.bump(detector);
    // indexed before the strategy: masked or dropped values still say whose data went by
    this.collector?.add(detector, raw);
    const value = typeof raw === 'string' ? raw : JSON.stringify(raw);
    switch (strategy) {
      case 'drop':
        return DROP;
      case 'mask':
        return typeof raw === 'string' || typeof raw === 'number' ? maskValue(detector, String(raw)) : '***';
      case 'hash':
        return hashValue(this.opts.key, detector, value);
      case 'tokenize': {
        const token = tokenFor(this.opts.key, detector, value);
        this.tokens.set(token, { token, detector, value });
        return token;
      }
    }
  }

  /** PII by value inside free text. */
  private scanString(s: string, path: PathSeg[]): string | typeof DROP {
    const matches = findValueMatches(s, this.valueDetectors);
    if (!matches.length) return s;
    let out = '';
    let last = 0;
    for (const m of matches) {
      const strategy = this.strategyFor(m.detector.id, path);
      const replaced = this.transform(m.detector.id, strategy, m.text);
      if (replaced === DROP && m.start === 0 && m.end === s.length) return DROP;
      out += s.slice(last, m.start) + (replaced === DROP ? removedText(this.opts.locale) : String(replaced));
      last = m.end;
    }
    return out + s.slice(last);
  }

  /** Plain numbers with 11/14 valid digits (CPF/CNPJ/PIS stored as numbers, leading zeros lost). */
  private scanNumber(n: number, path: PathSeg[]): unknown | typeof DROP {
    if (!Number.isInteger(n)) return n;
    const s = String(n);
    const padded11 = s.padStart(11, '0');
    const detector =
      s.length === 14 && isValidCnpj(s)
        ? 'cnpj'
        : s.length >= 9 && s.length <= 11 && isValidCpf(padded11)
          ? 'cpf'
          : s.length >= 9 && s.length <= 11 && isValidPis(padded11)
            ? 'pis'
            : undefined;
    if (!detector) return n;
    return this.transform(detector, this.strategyFor(detector, path), detector === 'cnpj' ? s : padded11);
  }

  walk(value: unknown, path: PathSeg[]): unknown | typeof DROP {
    if (typeof value === 'string') return this.scanString(value, path);
    if (typeof value === 'number') return this.scanNumber(value, path);
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      value.forEach((item, i) => {
        const r = this.walk(item, [...path, i]);
        out.push(r === DROP ? null : r);
      });
      return out;
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const p = [...path, k];
        const r = this.field(k, v, p);
        if (r !== DROP) out[k] = r;
      }
      return out;
    }
    return value;
  }

  private field(key: string, value: unknown, path: PathSeg[]): unknown | typeof DROP {
    if (value === null || value === undefined) return value;
    const custom = this.selectorRules.find((r) => matchesSelector(r.fieldSelector!, path));
    if (custom) return this.transform(custom.detector, custom.strategy, value);
    const det = detectFieldName(key, this.fieldDetectors);
    if (det) {
      const isContainer = typeof value === 'object';
      // An `email` field whose value does not look like an e-mail etc. is still handled by name.
      if (!isContainer || det.category === 'saude' || det.id === 'endereco' || det.id === 'salario') {
        return this.transform(det.id, this.strategyFor(det.id, path), value);
      }
      // `{"rg": ["…"]}`, `{"cnh": {"numero": "…"}}`: the name covers everything inside it
      return this.byName(det.id, value, path);
    }
    return this.walk(value, path);
  }

  /** Applies a name-based detector to every scalar inside a container (inner PII names win). */
  private byName(detector: string, value: unknown, path: PathSeg[]): unknown | typeof DROP {
    if (Array.isArray(value)) {
      return value.map((item, i) => {
        const r = this.byName(detector, item, [...path, i]);
        return r === DROP ? null : r;
      });
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const p = [...path, k];
        const r = detectFieldName(k, this.fieldDetectors) ? this.field(k, v, p) : this.byName(detector, v, p);
        if (r !== DROP) out[k] = r;
      }
      return out;
    }
    if (typeof value === 'string' || typeof value === 'number') return this.transform(detector, this.strategyFor(detector, path), value);
    return value;
  }
}

/** Applies redaction to a JSON value (without mutating the original). */
export function redact<T>(value: T, opts: RedactOptions): RedactResult<T> {
  const rules = applicableRules(opts.rules, opts);
  const r = new Redactor(rules, opts);
  const out = r.walk(value, []);
  return {
    value: (out === DROP ? null : out) as T,
    count: r.count,
    byDetector: r.byDetector,
    tokens: [...r.tokens.values()],
    ...(r.collector ? { fingerprints: r.collector.fingerprints, fingerprintsTruncated: r.collector.truncated } : {}),
  };
}

/**
 * Identifiers in a value (e.g. the call arguments) without changing it: same detection as
 * redaction, only the fingerprints are kept.
 */
export function scanIdentifiers(value: unknown, fingerprints: FingerprintOptions, opts: Pick<RedactOptions, 'fieldDetectors' | 'valueDetectors'> = {}): { fingerprints: SubjectFingerprint[]; truncated: boolean } {
  const r = redact(value, { direction: 'request', rules: [], key: Buffer.alloc(32), fingerprints, ...opts });
  return { fingerprints: r.fingerprints ?? [], truncated: r.fingerprintsTruncated ?? false };
}

/** Free-text redaction (non-JSON responses, error messages). */
export function redactText(text: string, opts: RedactOptions): RedactResult<string> {
  const res = redact(text, opts);
  return { ...res, value: res.value === null ? removedText(opts.locale) : (res.value as string) };
}

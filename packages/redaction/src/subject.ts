import { createHmac } from 'node:crypto';
import { isValidCnpj, isValidCpf, isValidPis } from './detectors';

/**
 * LGPD subject index (ADR-017): a keyed fingerprint of a normalized identifier. Formatting does
 * not matter (`123.456.789-09` and `12345678909` give the same fingerprint) and another tenant
 * key gives another fingerprint. It is pseudonymization: still personal data under LGPD.
 */
export interface SubjectFingerprint {
  detector: string;
  fp: Buffer;
}

export interface FingerprintOptions {
  /** Tenant subject-index key (distinct from the PII hash key). */
  key: Uint8Array;
  /** Detectors whose values are fingerprinted. */
  detectors: ReadonlySet<string>;
  /** At most this many distinct fingerprints per call; beyond it the call is marked truncated. */
  max: number;
}

const digits = (v: string) => v.replace(/\D/g, '');

/** Canonical form of an identifier; `undefined` when it is not a valid one (nothing is indexed). */
export function normalizeIdentifier(detector: string, value: string): string | undefined {
  switch (detector) {
    case 'cpf': {
      const d = digits(value).padStart(11, '0');
      return d.length === 11 && isValidCpf(d) ? d : undefined;
    }
    case 'cnpj': {
      const d = digits(value).padStart(14, '0');
      return d.length === 14 && isValidCnpj(d) ? d : undefined;
    }
    case 'pis': {
      const d = digits(value).padStart(11, '0');
      return d.length === 11 && isValidPis(d) ? d : undefined;
    }
    case 'telefone': {
      let d = digits(value);
      if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
      return d.length >= 10 && d.length <= 11 ? d : undefined;
    }
    case 'email': {
      const v = value.trim().toLowerCase();
      return /^[^\s@]+@[^\s@]+$/.test(v) ? v : undefined;
    }
    default: {
      const v = value.trim().toLowerCase();
      return v || undefined;
    }
  }
}

/** HMAC-SHA256(key, "detector:normalized"), truncated to 16 bytes. */
export function subjectFingerprint(key: Uint8Array, detector: string, value: string): Buffer | undefined {
  const normalized = normalizeIdentifier(detector, value);
  if (normalized === undefined) return undefined;
  return createHmac('sha256', key).update(`${detector}:${normalized}`).digest().subarray(0, 16);
}

/** Collects distinct fingerprints up to `max` (used inside the redaction walk). */
export class FingerprintCollector {
  private readonly seen = new Map<string, SubjectFingerprint>();
  truncated = false;

  constructor(private readonly opts: FingerprintOptions) {}

  add(detector: string, raw: unknown): void {
    if (!this.opts.detectors.has(detector) || (typeof raw !== 'string' && typeof raw !== 'number')) return;
    const fp = subjectFingerprint(this.opts.key, detector, String(raw));
    if (!fp) return;
    const id = `${detector}:${fp.toString('hex')}`;
    if (this.seen.has(id)) return;
    if (this.seen.size >= this.opts.max) {
      this.truncated = true;
      return;
    }
    this.seen.set(id, { detector, fp });
  }

  get fingerprints(): SubjectFingerprint[] {
    return [...this.seen.values()];
  }
}

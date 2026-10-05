import { describe, expect, it } from 'vitest';
import { redact, scanIdentifiers } from './engine';
import { normalizeIdentifier, subjectFingerprint } from './subject';

const key = Buffer.alloc(32, 1);
const other = Buffer.alloc(32, 2);
const CPF = '529.982.247-25';
const opts = { key, detectors: new Set(['cpf', 'email']), max: 10 };

describe('subject index fingerprints (F15.11)', () => {
  it('normalizes formatting and rejects invalid identifiers', () => {
    expect(normalizeIdentifier('cpf', CPF)).toBe('52998224725');
    expect(normalizeIdentifier('cpf', '52998224725')).toBe('52998224725');
    expect(normalizeIdentifier('cpf', '111.111.111-12')).toBeUndefined();
    expect(normalizeIdentifier('email', '  Ana.Souza@Empresa.com ')).toBe('ana.souza@empresa.com');
    expect(normalizeIdentifier('telefone', '+55 (11) 98765-4321')).toBe('11987654321');
  });

  it('same identifier → same fingerprint; another tenant key → another one', () => {
    const a = subjectFingerprint(key, 'cpf', CPF)!;
    expect(a).toHaveLength(16);
    expect(subjectFingerprint(key, 'cpf', '52998224725')!.equals(a)).toBe(true);
    expect(subjectFingerprint(other, 'cpf', CPF)!.equals(a)).toBe(false);
  });

  it('redaction collects fingerprints before masking or dropping, deduplicated and capped', () => {
    const value = { items: [{ cpf: CPF, email: 'ana@x.com', obs: `cpf ${CPF.replace(/\D/g, '')}` }, { cpf: '390.533.447-05' }] };
    const r = redact(value, { direction: 'response', rules: [{ scope: 'global', detector: 'cpf', strategy: 'drop', direction: 'both' }], key, fingerprints: opts });
    expect(JSON.stringify(r.value)).not.toContain('529');
    expect(r.fingerprints!.map((f) => f.detector).sort()).toEqual(['cpf', 'cpf', 'email']);
    expect(r.fingerprintsTruncated).toBe(false);
    const capped = redact(value, { direction: 'response', rules: [], key, fingerprints: { ...opts, max: 1 } });
    expect(capped.fingerprints).toHaveLength(1);
    expect(capped.fingerprintsTruncated).toBe(true);
    expect(redact(value, { direction: 'response', rules: [], key }).fingerprints).toBeUndefined();
  });

  it('scanIdentifiers reads request arguments without changing them', () => {
    const args = { filtro: { cpf: CPF }, q: 'nada' };
    const r = scanIdentifiers(args, opts);
    expect(r.fingerprints).toHaveLength(1);
    expect(r.fingerprints[0]!.fp.equals(subjectFingerprint(key, 'cpf', CPF)!)).toBe(true);
    expect(args.filtro.cpf).toBe(CPF);
  });
});

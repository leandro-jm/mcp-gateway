/**
 * PII detectors (pure).
 * - By value: patterns with validation (check digit, Luhn, mod 97) to avoid false positives.
 * - By field name: configurable synonyms, compared by tokens (normalized snake_case).
 *
 * Detector ids and categories are Brazilian domain identifiers (persisted in `pii_rules`) and stay as-is.
 */

export type DetectorCategory = 'documento' | 'contato' | 'saude' | 'financeiro' | 'pessoal';

export interface ValueDetector {
  id: string;
  category: DetectorCategory;
  /** Global regex to find candidates inside texts. */
  pattern: RegExp;
  validate?: (match: string) => boolean;
}

const onlyDigits = (s: string) => s.replace(/\D/g, '');
const allSame = (d: string) => /^(\d)\1+$/.test(d);

export function isValidCpf(input: string): boolean {
  const d = onlyDigits(input);
  if (d.length !== 11 || allSame(d)) return false;
  const calc = (n: number) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(d[i]) * (n + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

export function isValidCnpj(input: string): boolean {
  const d = onlyDigits(input);
  if (d.length !== 14 || allSame(d)) return false;
  const calc = (n: number) => {
    const weights = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((acc, w, i) => acc + w * Number(d[i]), 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

export function isValidPis(input: string): boolean {
  const d = onlyDigits(input);
  if (d.length !== 11 || allSame(d)) return false;
  const weights = [3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(d[i]), 0);
  const r = 11 - (sum % 11);
  return (r === 10 || r === 11 ? 0 : r) === Number(d[10]);
}

export function luhn(input: string): boolean {
  const d = onlyDigits(input);
  if (d.length < 13 || d.length > 19 || allSame(d)) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

export function isValidIban(input: string): boolean {
  const s = input.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of numeric) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

const VALID_DDD = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48, 49, 51,
  53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93,
  94, 95, 96, 97, 98, 99,
]);

export function isValidPhoneBr(input: string): boolean {
  let d = onlyDigits(input);
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return false;
  if (!VALID_DDD.has(Number(d.slice(0, 2)))) return false;
  // mobile (11 digits) starts with 9; landline (10) with 2–5
  return d.length === 11 ? d[2] === '9' : /[2-5]/.test(d[2]!);
}

/**
 * Value detectors. Order matters: CPF before PIS (both have 11 digits).
 * Unformatted numbers are only accepted with check-digit validation.
 */
export const VALUE_DETECTORS: ValueDetector[] = [
  // The lookbehind only lets a match start at the beginning of a local part, and the domain is
  // bounded (RFC 1035): without both, a long run of letters costs quadratic time.
  { id: 'email', category: 'contato', pattern: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}(?![A-Za-z])/g },
  { id: 'cnpj', category: 'documento', pattern: /(?<![\dA-Za-z])(?:\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{14})(?![\dA-Za-z])/g, validate: isValidCnpj },
  { id: 'cpf', category: 'documento', pattern: /(?<![\dA-Za-z])(?:\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})(?![\dA-Za-z])/g, validate: isValidCpf },
  { id: 'pis', category: 'documento', pattern: /(?<![\dA-Za-z])(?:\d{3}\.\d{5}\.\d{2}-\d|\d{11})(?![\dA-Za-z])/g, validate: isValidPis },
  { id: 'cartao', category: 'financeiro', pattern: /(?<![\dA-Za-z])(?:\d{4}[ -]?){3}\d{1,7}(?![\dA-Za-z])/g, validate: luhn },
  { id: 'iban', category: 'financeiro', pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, validate: isValidIban },
  {
    id: 'telefone',
    category: 'contato',
    pattern: /(?<![\dA-Za-z])(?:\+?55[ -]?)?\(?\d{2}\)?[ -]?9?\d{4}[ -]?\d{4}(?![\dA-Za-z])/g,
    validate: isValidPhoneBr,
  },
  { id: 'cep', category: 'pessoal', pattern: /(?<![\dA-Za-z-])\d{5}-\d{3}(?![\dA-Za-z-])/g },
];

/** Configurable bank account detector (tenant pattern). */
export function bankAccountDetector(pattern: string): ValueDetector {
  return { id: 'conta', category: 'financeiro', pattern: new RegExp(pattern, 'g') };
}

// ---------------------------------------------------------------- by field name

export interface FieldDetector {
  id: string;
  category: DetectorCategory;
  synonyms: string[];
}

export const FIELD_DETECTORS: FieldDetector[] = [
  { id: 'cpf', category: 'documento', synonyms: ['cpf', 'nr_cpf', 'num_cpf'] },
  { id: 'cnpj', category: 'documento', synonyms: ['cnpj'] },
  { id: 'pis', category: 'documento', synonyms: ['pis', 'nis', 'pasep', 'pis_pasep', 'nit'] },
  { id: 'rg', category: 'documento', synonyms: ['rg', 'identidade', 'registro_geral'] },
  { id: 'cnh', category: 'documento', synonyms: ['cnh', 'carteira_motorista', 'habilitacao'] },
  { id: 'email', category: 'contato', synonyms: ['email', 'e_mail', 'mail'] },
  { id: 'telefone', category: 'contato', synonyms: ['telefone', 'celular', 'fone', 'phone', 'mobile', 'whatsapp'] },
  { id: 'data_nascimento', category: 'pessoal', synonyms: ['data_nascimento', 'nascimento', 'dt_nascimento', 'dt_nasc', 'birth_date', 'birthdate', 'dob'] },
  { id: 'endereco', category: 'pessoal', synonyms: ['endereco', 'address', 'logradouro'] },
  { id: 'cep', category: 'pessoal', synonyms: ['cep', 'zip', 'zipcode', 'postal_code'] },
  { id: 'salario', category: 'financeiro', synonyms: ['salario', 'remuneracao', 'vencimento', 'vencimentos', 'salary', 'wage', 'proventos'] },
  { id: 'conta', category: 'financeiro', synonyms: ['conta', 'conta_bancaria', 'conta_corrente', 'account_number', 'bank_account'] },
  { id: 'agencia', category: 'financeiro', synonyms: ['agencia', 'branch_number'] },
  { id: 'cartao', category: 'financeiro', synonyms: ['cartao', 'numero_cartao', 'card_number'] },
  { id: 'cid', category: 'saude', synonyms: ['cid', 'cid10', 'cid_10', 'diagnostico'] },
  { id: 'atestado', category: 'saude', synonyms: ['atestado', 'atestado_medico', 'laudo'] },
];

/** `salarioBase`, `Data-Nascimento` → unaccented snake_case tokens. */
export function normalizeFieldName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/**
 * Detects by field name. Matches if the normalized name is the synonym or
 * contains the synonym as a token sequence (`salario_base`, `cpf_titular`).
 * Does not match loose substrings (`contato` is not `conta`).
 */
export function detectFieldName(name: string, detectors: FieldDetector[] = FIELD_DETECTORS): FieldDetector | undefined {
  const norm = `_${normalizeFieldName(name)}_`;
  return detectors.find((d) => d.synonyms.some((s) => norm.includes(`_${s}_`)));
}

/** Merges extra synonyms (tenant settings) into the default detectors. */
export function withSynonyms(extra: Record<string, string[]> | undefined): FieldDetector[] {
  if (!extra) return FIELD_DETECTORS;
  const out = FIELD_DETECTORS.map((d) => ({ ...d, synonyms: [...d.synonyms, ...(extra[d.id] ?? []).map(normalizeFieldName)] }));
  for (const [id, syns] of Object.entries(extra)) {
    if (!out.some((d) => d.id === id)) out.push({ id, category: 'pessoal', synonyms: syns.map(normalizeFieldName) });
  }
  return out;
}

export interface ValueMatch {
  detector: ValueDetector;
  start: number;
  end: number;
  text: string;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Finds PII by value inside a text (no overlap; the first detector wins).
 * Digits glued to letters (hex ids, trace ids) and UUID fragments are not PII.
 */
export function findValueMatches(text: string, detectors: ValueDetector[] = VALUE_DETECTORS): ValueMatch[] {
  const matches: ValueMatch[] = [];
  const taken: Array<[number, number]> = [...text.matchAll(UUID_RE)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);
  for (const det of detectors) {
    det.pattern.lastIndex = 0;
    for (const m of text.matchAll(det.pattern)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (overlaps(start, end)) continue;
      if (det.validate && !det.validate(m[0])) continue;
      matches.push({ detector: det, start, end, text: m[0] });
      taken.push([start, end]);
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

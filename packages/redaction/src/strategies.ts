import { createHmac } from 'node:crypto';

export type Strategy = 'mask' | 'hash' | 'drop' | 'tokenize';

export const TOKEN_PREFIX = 'pii_tok_';
export const TOKEN_RE = /pii_tok_[a-f0-9]{24}/g;

const digitsOnly = (s: string) => s.replace(/\D/g, '');

/** Masks preserving the format and keeping only the non-identifying middle/final digits. */
export function maskValue(detector: string, value: string): string {
  switch (detector) {
    case 'cpf': {
      const d = digitsOnly(value);
      return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
    }
    case 'cnpj': {
      const d = digitsOnly(value);
      return `**.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-**`;
    }
    case 'pis': {
      const d = digitsOnly(value);
      return `***.${d.slice(3, 8)}.**-*`;
    }
    case 'email': {
      const [user = '', domain = ''] = value.split('@');
      const dot = domain.lastIndexOf('.');
      const host = dot > 0 ? domain.slice(0, dot) : domain;
      const tld = dot > 0 ? domain.slice(dot) : '';
      return `${user.slice(0, 1)}***@${host.slice(0, 1)}***${tld}`;
    }
    case 'telefone': {
      const d = digitsOnly(value);
      return `(**) *****-${d.slice(-4)}`;
    }
    case 'cartao': {
      const d = digitsOnly(value);
      return `**** **** **** ${d.slice(-4)}`;
    }
    case 'cep':
      return `${digitsOnly(value).slice(0, 2)}***-***`;
    default:
      return '***';
  }
}

export function hashValue(key: Buffer, detector: string, value: string): string {
  return `pii_h_${createHmac('sha256', key).update(`${detector}:${value}`).digest('hex').slice(0, 16)}`;
}

/** Deterministic token per tenant: the same value yields the same token (allows correlation). */
export function tokenFor(key: Buffer, detector: string, value: string): string {
  return `${TOKEN_PREFIX}${createHmac('sha256', key).update(`tok:${detector}:${value}`).digest('hex').slice(0, 24)}`;
}

import { fakeCpf, fakePis, prng } from '@mcp-gateway/testkit';
import { describe, expect, it } from 'vitest';
import {
  detectFieldName,
  findValueMatches,
  isValidCnpj,
  isValidCpf,
  isValidIban,
  isValidPhoneBr,
  isValidPis,
  luhn,
  withSynonyms,
} from '../src';

const ids = (text: string) => findValueMatches(text).map((m) => [m.detector.id, m.text]);

describe('value detectors', () => {
  it('a valid CPF (formatted or not) is detected; an invalid one is not', () => {
    const rand = prng(1);
    for (let i = 0; i < 50; i++) expect(isValidCpf(fakeCpf(rand))).toBe(true);
    expect(ids('CPF 529.982.247-25 do titular')).toEqual([['cpf', '529.982.247-25']]);
    expect(ids('cpf=52998224725;')).toEqual([['cpf', '52998224725']]);
    // 11 digits without a valid check digit: not a CPF by value (nor PIS)
    expect(isValidCpf('12345678901')).toBe(false);
    expect(ids('pedido 12345678901 aprovado')).toEqual([]);
    expect(isValidCpf('111.111.111-11')).toBe(false);
  });

  it('CNPJ, PIS, card (Luhn) and IBAN with validation', () => {
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11.222.333/0001-82')).toBe(false);
    expect(ids('Empresa 11.222.333/0001-81')).toEqual([['cnpj', '11.222.333/0001-81']]);
    const rand = prng(2);
    for (let i = 0; i < 20; i++) expect(isValidPis(fakePis(rand))).toBe(true);
    expect(ids('PIS 120.54321.12-0')).toEqual(isValidPis('120.54321.12-0') ? [['pis', '120.54321.12-0']] : []);
    expect(luhn('4111 1111 1111 1111')).toBe(true);
    expect(luhn('4111 1111 1111 1112')).toBe(false);
    expect(ids('cartão 4111-1111-1111-1111 ok')).toEqual([['cartao', '4111-1111-1111-1111']]);
    expect(isValidIban('DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(isValidIban('DE89 3704 0044 0532 0130 01')).toBe(false);
  });

  it('e-mail, BR phone and CEP', () => {
    expect(ids('fale com ana.silva@empresa.com.br hoje')).toEqual([['email', 'ana.silva@empresa.com.br']]);
    expect(isValidPhoneBr('(11) 98765-4321')).toBe(true);
    expect(isValidPhoneBr('+55 11 3456-7890')).toBe(true);
    expect(isValidPhoneBr('(00) 98765-4321')).toBe(false); // nonexistent area code
    expect(ids('ligar (21) 99876-5432')).toEqual([['telefone', '(21) 99876-5432']]);
    expect(ids('CEP 01310-100')).toEqual([['cep', '01310-100']]);
  });

  it('e-mail detection stays linear on long runs (ReDoS)', () => {
    expect(ids('a: x@y.com, b: z@w.org.')).toEqual([
      ['email', 'x@y.com'],
      ['email', 'z@w.org'],
    ]);
    for (const evil of ['a'.repeat(1_000_000), 'a.'.repeat(500_000), 'a@'.repeat(500_000), `x@${'a'.repeat(1_000_000)}`]) {
      const t0 = performance.now();
      findValueMatches(evil);
      expect(performance.now() - t0).toBeLessThan(500);
    }
  });

  it('does not mistake hex ids, UUIDs and trace ids for PII (digits glued to letters)', async () => {
    const { randomBytes, randomUUID } = await import('node:crypto');
    let hits = 0;
    for (let i = 0; i < 20000; i++) hits += findValueMatches(i % 2 ? randomUUID() : randomBytes(16).toString('hex')).length;
    expect(hits).toBe(0);
    expect(ids('id 0b36943d-8ddb-476f-9f8e-b02120969137 ok')).toEqual([]);
    expect(ids('trace dd3e250477c7b10f5426b58877420545')).toEqual([]);
    // real PII is still detected next to letters separated by space/punctuation
    expect(ids('cpf:529.982.247-25;')).toEqual([['cpf', '529.982.247-25']]);
  });

  it('does not mistake dates, ids and common values for PII', () => {
    expect(ids('2026-10-01T08:00:00-03:00')).toEqual([]);
    expect(ids('col-00001 matrícula 10000 R$ 5380,38')).toEqual([]);
    expect(ids('versão 1.2.3 build 20261001')).toEqual([]);
  });
});

describe('field-name detectors', () => {
  it.each([
    ['salario', 'salario'],
    ['salarioBase', 'salario'],
    ['remuneracao_total', 'salario'],
    ['data_nascimento', 'data_nascimento'],
    ['dataNascimento', 'data_nascimento'],
    ['RG', 'rg'],
    ['cnh_numero', 'cnh'],
    ['CID', 'cid'],
    ['atestado_medico', 'atestado'],
    ['endereço', 'endereco'],
    ['conta_bancaria', 'conta'],
    ['agencia', 'agencia'],
    ['cpf_titular', 'cpf'],
  ])('%s → %s', (field, det) => expect(detectFieldName(field)?.id).toBe(det));

  it.each(['contato', 'nome', 'cargo', 'matricula', 'escala_id', 'cidade', 'cidadania', 'decidir'])('%s is not PII by name', (f) =>
    expect(detectFieldName(f)).toBeUndefined(),
  );

  it('configurable synonyms', () => {
    const dets = withSynonyms({ salario: ['valorBruto'], matricula: ['matricula'] });
    expect(detectFieldName('valor_bruto', dets)?.id).toBe('salario');
    expect(detectFieldName('matricula', dets)?.id).toBe('matricula');
  });
});

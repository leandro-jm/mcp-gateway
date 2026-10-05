import { describe, expect, it } from 'vitest';
import { applicableRules, matchesSelector, redact, redactText, relaxOutputSchema, TOKEN_RE, type PiiRule } from '../src';

const key = Buffer.alloc(32, 9);
const colab = {
  id: 'col-1',
  nome: 'Ana Souza',
  cpf: '529.982.247-25',
  email: 'ana@empresa.com',
  telefone: '(11) 98765-4321',
  salario: 5380.38,
  data_nascimento: '1990-01-01',
  endereco: { logradouro: 'Rua X, 1', cidade: 'SP', cep: '01310-100' },
  observacao: 'documento 529.982.247-25, contato ana@empresa.com',
  saude: { cid: 'F32', atestado: 'texto' },
};

describe('redaction with the default policy', () => {
  it('mask for documents and contact, drop for health and salary, in nested objects and arrays', () => {
    const r = redact({ items: [colab, { ...colab, id: 'col-2' }], total: 2 }, { direction: 'response', rules: [], key });
    const [a] = r.value.items;
    expect(a).toEqual({
      id: 'col-1',
      nome: 'Ana Souza',
      cpf: '***.982.247-**',
      email: 'a***@e***.com',
      telefone: '(**) *****-4321',
      data_nascimento: '***',
      endereco: '***',
      observacao: 'documento ***.982.247-**, contato a***@e***.com',
      saude: {},
    });
    expect(r.value.total).toBe(2);
    expect(r.count).toBe(2 * 10);
    expect(r.byDetector).toMatchObject({ cpf: 4, email: 4, salario: 2, cid: 2, atestado: 2 });
    expect(JSON.stringify(r.value)).not.toMatch(/529\.982\.247-25|ana@empresa|5380/);
    // original untouched
    expect(colab.cpf).toBe('529.982.247-25');
  });

  it('a CPF stored as a number is also detected', () => {
    const r = redact({ documento: 52998224725, outro: 12345678901 }, { direction: 'response', rules: [], key });
    expect(r.value).toEqual({ documento: '***.982.247-**', outro: 12345678901 });
  });
});

describe('strategies', () => {
  const rule = (detector: string, strategy: PiiRule['strategy'], extra: Partial<PiiRule> = {}): PiiRule => ({
    scope: 'global',
    detector,
    strategy,
    direction: 'both',
    ...extra,
  });

  it('hash is deterministic (allows correlation) and does not reveal the value', () => {
    const opts = { direction: 'response' as const, rules: [rule('cpf', 'hash')], key };
    const a = redact([{ cpf: '529.982.247-25' }, { cpf: '529.982.247-25' }], opts).value;
    expect(a[0]!.cpf).toMatch(/^pii_h_[a-f0-9]{16}$/);
    expect(a[0]!.cpf).toBe(a[1]!.cpf);
    const other = redact({ cpf: '529.982.247-25' }, { ...opts, key: Buffer.alloc(32, 1) }).value;
    expect(other.cpf).not.toBe(a[0]!.cpf);
  });

  it('a sensitive name covers values nested under it; CPF numbers that lost leading zeros', () => {
    const r = redact(
      { rg: ['12.345.678-9'], cnh: { numero: '01234567890', valida: true }, nascimentos: { data_nascimento: ['1990-01-01'] }, n: 52998224725, curto: 100000037 },
      { direction: 'response', rules: [], key },
    );
    expect(r.value).toEqual({ rg: ['***'], cnh: { numero: '***', valida: true }, nascimentos: { data_nascimento: ['***'] }, n: expect.stringMatching(/^\*\*\*/), curto: expect.stringMatching(/^\*\*\*/) });
  });

  it('drop removes the field; in an array it becomes null; in text it becomes [removed]', () => {
    const r = redact(
      { email: 'a@b.com', lista: ['a@b.com', 'x'], texto: 'send to a@b.com' },
      { direction: 'response', rules: [rule('email', 'drop')], key },
    );
    expect(r.value).toEqual({ lista: [null, 'x'], texto: 'send to [removed]' });
    const pt = redact({ texto: 'mande para a@b.com' }, { direction: 'response', rules: [rule('email', 'drop')], key, locale: 'pt-BR' });
    expect(pt.value).toEqual({ texto: 'mande para [removido]' });
    expect(redactText('a@b.com', { direction: 'response', rules: [rule('email', 'drop')], key, locale: 'es' }).value).toBe('[eliminado]');
  });

  it('tokenize produces stable tokens and returns the values for the vault', () => {
    const r = redact({ items: [{ cpf: '529.982.247-25' }, { cpf: '529.982.247-25' }] }, { direction: 'response', rules: [rule('cpf', 'tokenize')], key });
    const t = r.value.items[0]!.cpf;
    expect(t).toMatch(TOKEN_RE);
    expect(r.value.items[1]!.cpf).toBe(t);
    expect(r.tokens).toEqual([{ token: t, detector: 'cpf', value: '529.982.247-25' }]);
  });

  it('precedence: tool > source > global; a field selector restricts the rule', () => {
    const rules: PiiRule[] = [
      rule('cpf', 'drop'),
      rule('cpf', 'hash', { scope: 'source', scopeRef: 's1' }),
      rule('cpf', 'tokenize', { scope: 'tool', scopeRef: 't1', fieldSelector: '$.titular.cpf' }),
      rule('cpf', 'mask', { scope: 'tool', scopeRef: 'outra' }),
    ];
    const v = { titular: { cpf: '529.982.247-25' }, dependente: { cpf: '529.982.247-25' } };
    const r = redact(v, { direction: 'response', rules, key, toolId: 't1', sourceId: 's1' }).value;
    expect(r.titular.cpf).toMatch(TOKEN_RE);
    expect(r.dependente.cpf).toMatch(/^pii_h_/);
    const g = redact(v, { direction: 'response', rules, key, toolId: 'x', sourceId: 'y' }).value;
    expect(g).toEqual({ titular: {}, dependente: {} });
    expect(applicableRules(rules, { direction: 'response', toolId: 't1', sourceId: 's1' }).map((x) => x.strategy)).toEqual(['tokenize', 'hash', 'drop']);
  });

  it('custom field rule by selector and direction', () => {
    const rules: PiiRule[] = [
      { scope: 'global', detector: 'field', fieldSelector: '$.items[*].matricula', strategy: 'hash', direction: 'response' },
    ];
    const v = { items: [{ matricula: '10000' }], matricula: '1' };
    expect(redact(v, { direction: 'response', rules, key }).value).toEqual({ items: [{ matricula: expect.stringMatching(/^pii_h_/) }], matricula: '1' });
    expect(redact(v, { direction: 'request', rules, key }).value).toEqual(v);
  });

  it('free text', () => {
    expect(redactText('CPF 529.982.247-25 invalid', { direction: 'response', rules: [], key }).value).toBe('CPF ***.982.247-** invalid');
  });
});

describe('selectors', () => {
  it.each([
    ['cpf', ['items', 0, 'cpf'], true],
    ['$.items[*].cpf', ['items', 3, 'cpf'], true],
    ['$.items[*].cpf', ['cpf'], false],
    ['$..cpf', ['a', 'b', 0, 'cpf'], true],
    ['$.a.*', ['a', 'x'], true],
    ['$.a', ['a', 'x'], false],
  ] as const)('%s on %j → %s', (sel, path, ok) => expect(matchesSelector(sel, [...path])).toBe(ok));
});

describe('relaxOutputSchema', () => {
  it('removes required and widens PII fields to string|null', () => {
    const s = relaxOutputSchema({
      type: 'object',
      required: ['items'],
      properties: {
        items: { type: 'array', items: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string' }, salario: { type: 'number' }, endereco: { type: 'object', properties: { cep: { type: 'string' } } } } } },
      },
    });
    expect(s.required).toBeUndefined();
    const item = (s.properties as any).items.items;
    expect(item.required).toBeUndefined();
    expect(item.additionalProperties).toBeUndefined();
    expect(item.properties.salario.type).toEqual(['number', 'string', 'null']);
    expect(item.properties.endereco).toMatchObject({ type: ['object', 'string', 'null'], additionalProperties: true });
  });
});

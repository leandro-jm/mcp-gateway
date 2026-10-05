import { describe, expect, it } from 'vitest';
import { applyFields, bytesOf, matchPath, parseSelector, project, suggestProjection } from './index';

const colabs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `col-${i}`,
    nome: `Pessoa ${i}`,
    cargo: 'Vigilante',
    endereco: { cidade: 'SP', uf: 'SP', logradouro: 'Rua muito comprida '.repeat(5) },
    escala: { id: 'esc-1', inicio: '07:00', fim: '19:00' },
    historico: Array.from({ length: 20 }, (_, j) => ({ data: `2026-01-${j}`, evento: 'x'.repeat(40) })),
  }));

describe('selectors', () => {
  it.each([
    ['$.items[*].nome', ['items', 3, 'nome'], 'full'],
    ['$.items[*].nome', ['items', 3], 'prefix'],
    ['$.items[*].nome', ['items'], 'prefix'],
    ['$.items[*].nome', ['total'], 'none'],
    ['$.items[*].nome', ['items', 3, 'nome', 'x'], 'full'],
    ['$..id', ['a', 0, 'b', 'id'], 'full'],
    ['$..id', ['a', 0], 'prefix'],
    ['$.a.*', ['a', 'x'], 'full'],
    ['$.a[0]', ['a', 1], 'none'],
    ['$', [], 'full'],
  ] as const)('%s × %j → %s', (sel, path, state) => expect(matchPath(parseSelector(sel), [...path])).toBe(state));
});

describe('projection', () => {
  const payload = { items: colabs(300), total: 300, page: 1 };

  it('include keeps only the requested paths (and the included envelope)', () => {
    const r = project(payload, { include: ['$.items[*].id', '$.items[*].nome', '$.items[*].escala.inicio', '$.total'] });
    expect((r.value as any).items[0]).toEqual({ id: 'col-0', nome: 'Pessoa 0', escala: { inicio: '07:00' } });
    expect((r.value as any).total).toBe(300);
    expect(r.value).not.toHaveProperty('page');
    expect(r.bytesAfter).toBeLessThan(r.bytesBefore / 5);
  });

  it('exclude removes fields in any item', () => {
    const r = project(payload, { exclude: ['$.items[*].historico', '$..logradouro'] });
    const first = (r.value as any).items[0];
    expect(first).not.toHaveProperty('historico');
    expect(first.endereco).toEqual({ cidade: 'SP', uf: 'SP' });
  });

  it('max_array_items truncates with { truncated, total } metadata', () => {
    const r = project(payload, { maxArrayItems: 10 });
    const v = r.value as any;
    expect(v.items).toHaveLength(10);
    expect(v.items[0].historico).toHaveLength(10);
    expect(v._meta.truncated).toBe(true);
    expect(v._meta.arrays['$.items']).toEqual({ total: 300, returned: 10 });
  });

  it('max_bytes cuts safely and always produces valid JSON', () => {
    for (const max of [200_000, 20_000, 2_000, 600]) {
      const r = project(payload, { maxBytes: max });
      const json = JSON.stringify(r.value);
      expect(() => JSON.parse(json)).not.toThrow();
      expect(bytesOf(r.value)).toBeLessThanOrEqual(max);
      expect((r.value as any)._meta.truncated).toBe(true);
    }
    const r = project(payload, { maxBytes: 20_000 });
    expect((r.value as any)._meta.arrays['$.items'].total).toBe(300);
  });

  it('_fields relative to the list items, keeping the envelope', () => {
    expect(applyFields({ items: [{ id: 1, nome: 'a', escala: { inicio: '7', fim: '19' } }], total: 1, meta: { x: 1 } }, ['id', 'escala.inicio'])).toEqual({
      items: [{ id: 1, escala: { inicio: '7' } }],
      total: 1,
    });
    expect(applyFields({ id: 1, nome: 'a', b: 2 }, ['nome'])).toEqual({ nome: 'a' });
    expect(applyFields([{ id: 1, tags: [{ n: 'x', y: 1 }] }], ['tags.n'])).toEqual([{ tags: [{ n: 'x' }] }]);
  });

  it('_fields does not expose a field removed by the policy (applied after include/exclude)', () => {
    const r = project(payload, { exclude: ['$.items[*].nome'] }, { fields: ['id', 'nome'] });
    expect((r.value as any).items[0]).toEqual({ id: 'col-0' });
  });

  it('adds a localized note when the response cannot fit max_bytes', () => {
    const wide = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`campo_${i}`, i]));
    expect((project(wide, { maxBytes: 100 }).value as any)._meta.note).toBe('response exceeds max_bytes (100) even after cutting');
    expect((project(wide, { maxBytes: 100 }, { locale: 'pt-BR' }).value as any)._meta.note).toBe('resposta excede max_bytes (100) mesmo após corte');
  });

  it('measures the byte reduction on a large payload', () => {
    const r = project(payload, { include: ['$.items[*].id', '$.items[*].nome'], maxArrayItems: 50 });
    const saved = r.bytesBefore - r.bytesAfter;
    expect(saved / r.bytesBefore).toBeGreaterThan(0.95);
  });
});

describe('suggested projection', () => {
  it('list: first-level item scalars + envelope', () => {
    const s = suggestProjection({
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, nome: { type: 'string' }, endereco: { type: 'object' }, ativo: { type: 'boolean' } } } },
        total: { type: 'integer' },
      },
    });
    expect(s).toEqual({ include: ['$.items[*].id', '$.items[*].nome', '$.items[*].ativo', '$.total'] });
    expect(suggestProjection({ type: 'object', properties: { id: { type: 'string' } } })).toBeUndefined();
  });
});

describe('selectValues', () => {
  const data = { items: [{ id: 'a', tags: [{ n: 1 }] }, { id: 'b', tags: [{ n: 2 }, { n: 3 }] }], total: 2 };
  it('with and without wildcard', async () => {
    const { selectValues } = await import('./index');
    expect(selectValues(data, '$.items[*].id')).toEqual(['a', 'b']);
    expect(selectValues(data, '$.total')).toBe(2);
    expect(selectValues(data, '$.items[1].id')).toBe('b');
    expect(selectValues(data, '$..n')).toEqual([1, 2, 3]);
    expect(selectValues(data, '$')).toEqual(data);
    expect(selectValues(data, '$.nada')).toBeUndefined();
  });
});

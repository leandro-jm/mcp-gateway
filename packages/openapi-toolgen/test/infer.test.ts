import { describe, expect, it } from 'vitest';
import { inferSchema } from '../src';

describe('inferSchema', () => {
  it('objects, heterogeneous arrays, dates and numbers', () => {
    expect(
      inferSchema({ id: 'x', n: 1, v: 1.5, ok: true, quando: '2026-10-01T08:00:00-03:00', dia: '2026-10-01', itens: [{ a: 1 }, { a: 2.5, b: 'x' }], nada: null }),
    ).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string' },
        n: { type: 'integer' },
        v: { type: 'number' },
        ok: { type: 'boolean' },
        quando: { type: 'string', format: 'date-time' },
        dia: { type: 'string', format: 'date' },
        itens: { type: 'array', items: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'string' } } } },
        nada: { type: 'null' },
      },
    });
  });
});

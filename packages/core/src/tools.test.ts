import { describe, expect, it } from 'vitest';
import { applyOverrides, canTransition, jsonMergePatch, targetState } from './tools';

describe('tool state transitions', () => {
  it.each([
    ['disabled', 'enable', true],
    ['enabled', 'disable', true],
    ['enabled', 'deprecate', true],
    ['deprecated', 'enable', true],
    ['disabled', 'deprecate', true],
    ['enabled', 'enable', false],
    ['removed', 'enable', false],
    ['removed', 'disable', false],
    ['removed', 'deprecate', false],
  ] as const)('%s --%s--> %s', (from, action, ok) => {
    expect(canTransition(from, targetState(action))).toBe(ok);
  });
});

describe('overrides', () => {
  it('merge patch RFC 7386', () => {
    expect(jsonMergePatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: null, e: 4 }, f: [1] })).toEqual({
      a: 1,
      b: { d: 3, e: 4 },
      f: [1],
    });
  });

  it('applies name, description and schema patch', () => {
    const eff = applyOverrides({
      name: 'rh_colaboradores_list',
      title: null,
      description: 'generated',
      inputSchema: { type: 'object', properties: { nome: { type: 'string' } } },
      overrides: {
        name: 'buscar_colaboradores',
        description: 'Busca colaboradores pelo nome',
        inputSchema: { properties: { nome: { description: 'Parte do nome' } } },
      },
    });
    expect(eff).toEqual({
      name: 'buscar_colaboradores',
      baseName: 'rh_colaboradores_list',
      title: null,
      description: 'Busca colaboradores pelo nome',
      inputSchema: { type: 'object', properties: { nome: { type: 'string', description: 'Parte do nome' } } },
    });
  });
});

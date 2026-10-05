import { describe, expect, it } from 'vitest';
import { globMatch, globSpecificity } from './glob';

describe('glob', () => {
  it('matches * and ? and escapes the rest', () => {
    expect(globMatch('rh_colaboradores_*', 'rh_colaboradores_list')).toBe(true);
    expect(globMatch('rh_colaboradores_*', 'rh_escalas_list')).toBe(false);
    expect(globMatch('*', 'anything')).toBe(true);
    expect(globMatch('rh_?_get', 'rh_x_get')).toBe(true);
    expect(globMatch('a.b', 'aXb')).toBe(false);
  });
  it('specificity: exact name > long glob > short glob', () => {
    expect(globSpecificity('rh_x_get')).toBeGreaterThan(globSpecificity('rh_x_*'));
    expect(globSpecificity('rh_x_*')).toBeGreaterThan(globSpecificity('rh_*'));
    expect(globSpecificity('rh_*')).toBeGreaterThan(globSpecificity('*'));
  });
});

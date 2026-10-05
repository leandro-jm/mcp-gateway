import { describe, expect, it } from 'vitest';
import { isIdSegment, singular, suggestName, templatePath } from '../src';

describe('templatePath', () => {
  it.each([
    ['/users/42', '/users/{user_id}'],
    ['/colaboradores/col-00001', '/colaboradores/{colaborador_id}'],
    ['/marcacoes/mar-1a2b', '/marcacoes/mar-1a2b'],
    ['/orders/550e8400-e29b-41d4-a716-446655440000/items/7', '/orders/{order_id}/items/{item_id}'],
    ['/v1/categories/12', '/v1/categories/{category_id}'],
    ['/reports/2026-10-01', '/reports/{report_date}'],
    ['/42', '/{id}'],
    ['/users/{userId}/posts/:postId', '/users/{user_id}/posts/{post_id}'],
    ['/users/{{userId}}', '/users/{user_id}'],
    ['/a/1/2', '/a/{a_id}/{id}'],
    ['/users/', '/users/'],
    ['/', '/'],
  ])('%s → %s', (input, expected) => {
    expect(templatePath(input).path).toBe(expected);
  });

  it('keeps samples of inferred parameters only', () => {
    expect(templatePath('/users/{x}/files/99').params).toEqual([{ name: 'x' }, { name: 'file_id', sample: '99' }]);
  });

  it('version segments and words are not identifiers', () => {
    expect(isIdSegment('v2')).toBe(false);
    expect(isIdSegment('me')).toBe(false);
    expect(isIdSegment('01HZX3K1Q5ZB9V8W7Y6T5S4R3P')).toBe(true);
  });

  it.each([
    ['users', 'user'],
    ['categories', 'category'],
    ['addresses', 'address'],
    ['colaboradores', 'colaborador'],
    ['marcacoes', 'marcacao'],
    ['status', 'statu'],
    ['data', 'data'],
  ])('singular(%s) = %s', (plural, expected) => {
    expect(singular(plural)).toBe(expected);
  });
});

describe('suggestName', () => {
  it.each([
    ['api.acme.com.br', 'acme'],
    ['www.example.com', 'example'],
    ['127.0.0.1', 'api'],
    ['RH Público API', 'rh_publico_api'],
    ['2024 Payments', 'payments'],
  ])('%s → %s', (input, expected) => {
    expect(suggestName(input)).toBe(expected);
  });
});

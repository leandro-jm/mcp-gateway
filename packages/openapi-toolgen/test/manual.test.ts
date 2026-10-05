import { msg, translate } from '@mcp-gateway/i18n/server';
import { describe, expect, it } from 'vitest';
import { buildManualTool, ManualToolError } from '../src';

describe('manual tools', () => {
  it('builds the input schema and mapping', () => {
    const t = buildManualTool({ method: 'get', path: '/colaboradores/{id}', params: [{ name: 'id', in: 'path' }] });
    expect(t.inputSchema).toEqual({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false });
    expect(t.annotations).toEqual({ readOnlyHint: true });
  });

  it('errors carry a translatable message', () => {
    let err: ManualToolError | undefined;
    try {
      buildManualTool({ method: 'GET', path: '/x/{id}' });
    } catch (e) {
      err = e as ManualToolError;
    }
    expect(err).toBeInstanceOf(ManualToolError);
    expect(err!.msg).toEqual(msg('toolgen.manualPathParamUnmapped', { param: '{id}' }));
    expect(err!.message).toBe('path parameter {id} has no mapping');
    expect(translate(err!.msg, 'pt-BR')).toBe('parâmetro de path {id} sem mapeamento');
    expect(() => buildManualTool({ method: 'GET', path: 'x' })).toThrow('path must start with /');
  });
});

import { describe, expect, it } from 'vitest';
import { describeTool } from '../src/proxy/effect';

describe('effect sentence appended to tool descriptions', () => {
  const tool = (annotations: Record<string, boolean>, kind: 'openapi' | 'manual' | 'composite' = 'openapi', description = 'Lista colaboradores.') => ({
    kind,
    description,
    annotations,
  });

  it('derives the sentence from the annotations, in the requested locale', () => {
    expect(describeTool(tool({ readOnlyHint: true }), 'en')).toBe('Lista colaboradores. Read-only.');
    expect(describeTool(tool({ readOnlyHint: false }), 'pt-BR')).toBe('Lista colaboradores. Altera dados.');
    expect(describeTool(tool({ readOnlyHint: false, destructiveHint: true }), 'es')).toBe('Lista colaboradores. Modifica datos (operación destructiva).');
  });

  it('only applies to generated (openapi) tools', () => {
    expect(describeTool(tool({ readOnlyHint: true }, 'manual'), 'en')).toBe('Lista colaboradores.');
    expect(describeTool(tool({ readOnlyHint: true }, 'composite'), 'en')).toBe('Lista colaboradores.');
  });

  it('does not double-append when the description already ends with the sentence in any locale', () => {
    expect(describeTool(tool({ readOnlyHint: true }, 'openapi', 'Lista colaboradores. Read-only.'), 'en')).toBe('Lista colaboradores. Read-only.');
    expect(describeTool(tool({ readOnlyHint: true }, 'openapi', 'Lista colaboradores. Somente leitura.'), 'es')).toBe('Lista colaboradores. Somente leitura.');
    expect(describeTool(tool({ readOnlyHint: true }, 'openapi', ''), 'en')).toBe('Read-only.');
  });
});

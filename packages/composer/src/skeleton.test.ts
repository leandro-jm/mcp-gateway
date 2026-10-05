import { parseComposite, validateComposite } from '@mcp-gateway/composition';
import { describe, expect, it } from 'vitest';
import { skeletonFromSequence } from './skeleton';

const colab = {
  name: 'rh_colaborador_get',
  inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string', description: 'Employee id' } } },
  outputSchema: { type: 'object', properties: { id: { type: 'string' }, nome: { type: 'string' } } },
};
const escalas = {
  name: 'rh_escalas_list',
  inputSchema: { type: 'object', required: ['colaborador'], properties: { colaborador: { type: 'string' } } },
  outputSchema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { nome: { type: 'string' } } } } } },
};

describe('skeletonFromSequence (F15.20)', () => {
  it('wires matching fields and leaves the rest as inputs; the YAML parses as a composite', () => {
    const yaml = skeletonFromSequence([colab, escalas], { name: 'rh_colab_escalas', description: 'Suggested from 12 sessions' });
    const def = parseComposite(yaml);
    expect(def.input).toMatchObject({ required: ['id'], properties: { id: { type: 'string', description: 'Employee id' } } });
    expect(def.steps).toEqual([
      expect.objectContaining({ id: 'colaborador_get', tool: 'rh_colaborador_get', args: { id: '$input.id' } }),
      expect.objectContaining({ id: 'escalas_list', tool: 'rh_escalas_list', args: { colaborador: '$steps.colaborador_get.id' } }),
    ]);
    const catalog = new Map([colab, escalas].map((t, i) => [t.name, { id: `t${i}`, name: t.name, kind: 'openapi' as const, state: 'enabled' as const, inputSchema: t.inputSchema, annotations: { readOnlyHint: true } }]));
    const result = validateComposite(def, catalog);
    expect(result.errors).toEqual([]);
    expect(result.levels).toEqual([['colaborador_get'], ['escalas_list']]);
  });
});

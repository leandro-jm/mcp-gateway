import { describe, expect, it } from 'vitest';
import { compositeGraph, parseComposite } from '../src';

describe('compositeGraph (F14.4)', () => {
  it('builds nodes with levels and one edge per step reference', () => {
    const def = parseComposite(`
name: rh_resumo_colaborador
description: summary
steps:
  - id: colab
    tool: rh_colaborador_get
    args: { id: "$input.colaborador_id" }
  - id: escalas
    tool: rh_escalas_list
    args: { colaborador: "$steps.colab.id" }
  - id: marcacoes
    tool: rh_marcacoes_list
    args: { colaborador: '$steps["colab"].id' }
    when: "$exists($input.desde)"
  - id: totais
    tool: rh_totais
    foreach: { items: "$steps.marcacoes" }
    args: { id: "$item.id", escala: "$steps.escalas[0].id" }
`);
    const g = compositeGraph(def);
    expect(g.nodes).toEqual([
      { id: 'colab', tool: 'rh_colaborador_get', level: 0, conditional: false, foreach: false },
      { id: 'escalas', tool: 'rh_escalas_list', level: 1, conditional: false, foreach: false },
      { id: 'marcacoes', tool: 'rh_marcacoes_list', level: 1, conditional: true, foreach: false },
      { id: 'totais', tool: 'rh_totais', level: 2, conditional: false, foreach: true },
    ]);
    expect(g.edges).toEqual([
      { from: 'colab', to: 'escalas' },
      { from: 'colab', to: 'marcacoes' },
      { from: 'escalas', to: 'totais' },
      { from: 'marcacoes', to: 'totais' },
    ]);
  });

  it('is lenient with unknown references and cycles', () => {
    const def = parseComposite({
      name: 'ciclo',
      description: 'x',
      steps: [
        { id: 'a', tool: 't', args: { x: '$steps.b', y: '$steps.ghost', z: '$steps.a' } },
        { id: 'b', tool: 't', args: { x: '$steps.a' } },
      ],
    });
    const g = compositeGraph(def);
    expect(g.nodes.map((n) => n.level)).toEqual([0, 1]);
    expect(g.edges).toEqual([
      { from: 'b', to: 'a' },
      { from: 'a', to: 'b' },
    ]);
  });
});

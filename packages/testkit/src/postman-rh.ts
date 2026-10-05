import type { Colaborador, Marcacao } from './fake-data';

const jsonHeader = [{ key: 'Content-Type', value: 'application/json' }];
const example = (code: number, body: unknown) => ({ name: `HTTP ${code}`, code, header: jsonHeader, body: JSON.stringify(body, null, 2) });

/**
 * Postman v2.1 collection of the fake HR upstream (ADR-014), with example responses taken from its
 * data. The API key is a collection variable without value, as in a shared collection.
 */
export function rhPostmanCollection(baseUrl: string, data: { colaboradores: Colaborador[]; marcacoes: Marcacao[] }) {
  const [c1, c2] = data.colaboradores;
  return {
    info: {
      _postman_id: '0b6f3c1e-8a52-4d7e-9a0e-5c1b2f3e4d5a',
      name: 'RH Fake (Postman)',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: {
      type: 'apikey',
      apikey: [
        { key: 'key', value: 'x-api-key' },
        { key: 'value', value: '{{apiKey}}' },
        { key: 'in', value: 'header' },
      ],
    },
    variable: [{ key: 'baseUrl', value: baseUrl }, { key: 'apiKey', value: '' }],
    item: [
      {
        name: 'Colaboradores',
        item: [
          {
            name: 'Listar colaboradores',
            request: { method: 'GET', url: '{{baseUrl}}/colaboradores?size=20&unidade_id=uni-1' },
            response: [example(200, { items: [c1, c2], total: 2, page: 1, size: 20 })],
          },
          {
            name: 'Buscar colaborador',
            request: { method: 'GET', url: { raw: '{{baseUrl}}/colaboradores/:id', variable: [{ key: 'id', value: c1?.id, description: 'Employee id' }] } },
            response: [example(200, c1)],
          },
        ],
      },
      { name: 'Listar escalas', request: { method: 'GET', url: '{{baseUrl}}/escalas' } },
      {
        name: 'Marcações',
        item: [
          {
            name: 'Registrar marcação',
            request: {
              method: 'POST',
              header: jsonHeader,
              url: '{{baseUrl}}/marcacoes',
              body: { mode: 'raw', raw: JSON.stringify({ colaborador_id: c1?.id, data_hora: '2026-10-01T08:00:00-03:00', tipo: 'entrada' }), options: { raw: { language: 'json' } } },
            },
            response: [example(201, data.marcacoes[0])],
          },
          { name: 'Remover marcação', request: { method: 'DELETE', url: '{{baseUrl}}/marcacoes/:id' } },
        ],
      },
    ],
  };
}

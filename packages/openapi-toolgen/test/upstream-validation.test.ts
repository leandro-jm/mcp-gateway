import { FAKE_CREDENTIALS, startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateTools, parseSpec, type GeneratedTool } from '../src';

/** CA F2.3: the generated schema validates real payloads from the fake upstream. */
describe('generated schemas vs real payloads from the fake upstream', () => {
  let up: FakeUpstream;
  let tools: Record<string, GeneratedTool>;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats.default(ajv);

  beforeAll(async () => {
    up = await startFakeUpstream();
    const spec = await (await fetch(`${up.url}/openapi.json`)).json();
    const generated = generateTools(await parseSpec(spec), { sourceName: 'rh' });
    tools = Object.fromEntries(generated.tools.map((t) => [t.name, t]));
  });
  afterAll(async () => up.close());

  const headers = { 'x-api-key': FAKE_CREDENTIALS.apiKey, 'content-type': 'application/json' };

  async function check(toolName: string, res: Response) {
    const tool = tools[toolName]!;
    const body = await res.json();
    const wrap = tool.operationRef.mapping?.response?.wrap;
    const structured = wrap ? { [wrap]: body } : body;
    const validate = ajv.compile(tool.outputSchema!);
    expect(validate(structured), JSON.stringify(validate.errors)).toBe(true);
  }

  it('responses validate against the output schema', async () => {
    const colab = up.data.colaboradores[0]!;
    await check('rh_colaboradores_list', await fetch(`${up.url}/colaboradores?size=20`, { headers }));
    await check('rh_colaborador_get', await fetch(`${up.url}/colaboradores/${colab.id}`, { headers }));
    await check('rh_escalas_list', await fetch(`${up.url}/escalas`, { headers }));
    await check('rh_marcacoes_list', await fetch(`${up.url}/marcacoes?colaborador=${colab.id}`, { headers }));
  });

  it('valid arguments pass the input schema and the upstream accepts them', async () => {
    const tool = tools.rh_marcacao_create!;
    const args = { colaborador_id: up.data.colaboradores[1]!.id, data_hora: '2026-10-01T08:00:00-03:00', tipo: 'entrada' };
    const validate = ajv.compile(tool.inputSchema);
    expect(validate(args), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...args, tipo: 'almoco' })).toBe(false);
    expect(validate({ ...args, inexistente: 1 })).toBe(false);
    const res = await fetch(`${up.url}/marcacoes`, { method: 'POST', headers, body: JSON.stringify(args) });
    expect(res.status).toBe(201);
    await check('rh_marcacao_create', res);
  });
});

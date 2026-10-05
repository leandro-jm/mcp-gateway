import { generateTools, parseSpec } from '@mcp-gateway/openapi-toolgen';
import { describe, expect, it } from 'vitest';
import { ImportError, importCurl, parseImportText } from '../src';
import { splitCommands, tokenize } from '../src/curl';

const words = (input: string) => splitCommands(tokenize(input));
const keys = (warnings: { key: string }[]) => warnings.map((w) => w.key);

/** Pasted from API docs and browser devtools ("Copy as cURL"), with fake secrets. */
const SAMPLES = `
# list
curl -sS 'http://localhost:4010/colaboradores?unidade_id=uni-1&size=20&ativo=true' \\
  -H 'Accept: application/json' \\
  -H 'Authorization: Bearer secret-token-123'

curl http://localhost:4010/colaboradores/col-00001 -H "Authorization: Bearer secret-token-123" | jq .

curl -X POST http://localhost:4010/marcacoes \\
  -H 'Content-Type: application/json' -H 'Authorization: Bearer secret-token-123' \\
  --data-raw '{"colaborador_id":"col-00002","data_hora":"2026-10-01T08:00:00-03:00","tipo":"entrada"}'

curl -X DELETE "http://localhost:4010/marcacoes/mar-00012" -H "Authorization: Bearer secret-token-123"
`;

describe('cURL tokenizer', () => {
  it('handles quotes, escapes, ANSI-C strings and line continuations', () => {
    expect(words(`curl -H 'A: b c' -d "x=\\"1\\"" $'line\\nnext' \\\n  http://h/x`)).toEqual([['-H', 'A: b c', '-d', 'x="1"', 'line\nnext', 'http://h/x']]);
  });

  it('splits commands and ignores what is not curl', () => {
    expect(words('$ curl http://h/a | jq .\nexport X=1; curl http://h/b && echo ok')).toEqual([['http://h/a'], ['http://h/b']]);
  });

  it('supports PowerShell and cmd continuations', () => {
    expect(words('curl.exe http://h/a `\n -H "X-Trace: 1" ^\n -k')).toEqual([['http://h/a', '-H', 'X-Trace: 1', '-k']]);
  });

  it('rejects unterminated quotes', () => {
    expect(() => importCurl("curl 'http://h/a")).toThrow(ImportError);
  });
});

describe('cURL import', () => {
  const result = importCurl(SAMPLES);
  const paths = result.openapi.paths as Record<string, Record<string, any>>;

  it('builds one operation per method + templated path', () => {
    expect(Object.keys(paths).sort()).toEqual(['/colaboradores', '/colaboradores/{colaborador_id}', '/marcacoes', '/marcacoes/{marcacao_id}']);
    expect(Object.keys(paths['/marcacoes']!)).toEqual(['post']);
    expect(Object.keys(paths['/marcacoes/{marcacao_id}']!)).toEqual(['delete']);
    expect(result.baseUrlCandidates).toEqual(['http://localhost:4010']);
    expect(result.openapi.servers).toEqual([{ url: 'http://localhost:4010' }]);
  });

  it('infers query and body schemas', () => {
    const params = paths['/colaboradores']!.get.parameters;
    expect(params).toEqual([
      { name: 'unidade_id', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'size', in: 'query', required: false, schema: { type: 'integer' } },
      { name: 'ativo', in: 'query', required: false, schema: { type: 'boolean' } },
    ]);
    expect(paths['/marcacoes']!.post.requestBody).toEqual({
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { colaborador_id: { type: 'string' }, data_hora: { type: 'string', format: 'date-time' }, tipo: { type: 'string' } },
          },
        },
      },
    });
  });

  it('strips credentials, declares the scheme and suggests the credential type', () => {
    expect(result.openapi.components).toEqual({ securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } });
    expect(result.openapi.security).toEqual([{ bearerAuth: [] }]);
    expect(result.suggestedCredential).toEqual({ type: 'bearer_static' });
    expect(keys(result.warnings)).toEqual(['import.authStripped']);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('secret-token-123');
    // no sample values kept (PII)
    expect(serialized).not.toContain('col-00002');
    expect(serialized).not.toContain('uni-1');
  });

  it('suggests the source name from the host', () => {
    expect(result.suggestedName).toBe('localhost');
    expect(importCurl('curl https://api.acme.com.br/v1/users/42').suggestedName).toBe('acme');
  });

  it('generates tools through the regular pipeline (snapshot)', async () => {
    const generated = generateTools(await parseSpec(result.openapi), { sourceName: 'rh' });
    expect(generated.tools.map((t) => ({ name: t.name, operationKey: t.operationKey, inputSchema: t.inputSchema, annotations: t.annotations }))).toMatchSnapshot();
  });
});

describe('cURL options', () => {
  const op = (text: string, path: string, method: string) => (parseImportText(text).openapi.paths as any)[path][method];

  it('-G moves data to the query string', () => {
    expect(op('curl -G https://h.io/search -d q=abc -d limit=10', '/search', 'get').parameters.map((p: any) => p.name)).toEqual(['q', 'limit']);
  });

  it('data without content type is form-urlencoded; JSON-looking data is JSON', () => {
    expect(Object.keys(op('curl https://h.io/login -d user=a -d remember=true', '/login', 'post').requestBody.content)).toEqual(['application/x-www-form-urlencoded']);
    expect(Object.keys(op(`curl https://h.io/items -d '{"a":1}'`, '/items', 'post').requestBody.content)).toEqual(['application/json']);
  });

  it('--json, -F and short flags with attached values', () => {
    expect(Object.keys(op(`curl --json '{"a":1}' https://h.io/j`, '/j', 'post').requestBody.content)).toEqual(['application/json']);
    const form = op('curl -XPUT -F name=x -F file=@photo.png https://h.io/up', '/up', 'put');
    expect(form.requestBody.content['multipart/form-data'].schema.properties).toEqual({ name: { type: 'string' }, file: { type: 'string', format: 'binary' } });
  });

  it('-u, API key headers and query keys become security schemes', () => {
    const r = importCurl("curl -u user:pass 'https://h.io/a?api_key=k1&page=2' -H 'X-API-Key: k2' -H 'X-Tenant: acme'");
    expect(Object.keys((r.openapi.components as any).securitySchemes).sort()).toEqual(['apiKey_api_key', 'apiKey_x_api_key', 'basicAuth']);
    expect(r.suggestedCredential).toEqual({ type: 'basic' });
    const params = (r.openapi.paths as any)['/a'].get.parameters.map((p: any) => `${p.in}:${p.name}`);
    expect(params).toEqual(['query:page', 'header:X-Tenant']);
    expect(JSON.stringify(r)).not.toMatch(/k1|k2|pass/);
  });

  it('warns on unknown flags and file bodies', () => {
    const r = importCurl('curl --frobnicate https://h.io/a -d @body.json');
    expect(keys(r.warnings)).toEqual(['import.unknownCurlFlag', 'import.curlFileData']);
  });

  it('URL without scheme defaults to http', () => {
    expect(importCurl('curl localhost:4010/escalas').baseUrlCandidates).toEqual(['http://localhost:4010']);
  });

  it('fails without a URL', () => {
    expect(() => importCurl('curl -X GET')).toThrow(ImportError);
  });
});

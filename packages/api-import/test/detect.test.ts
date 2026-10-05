import { rhOpenApiSpec } from '@mcp-gateway/testkit';
import { describe, expect, it } from 'vitest';
import { detectFormat, ImportError, importDocument, parseImportText } from '../src';

const errorKey = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as { msg?: { key: string } }).msg?.key;
  }
  return undefined;
};

describe('detectFormat', () => {
  it.each([
    ['curl https://h.io', 'curl'],
    ['  $ curl -X POST https://h.io', 'curl'],
    ['{"openapi":"3.1.0","info":{},"paths":{}}', 'openapi'],
    ['swagger: "2.0"\ninfo: {title: x}\npaths: {}', 'openapi'],
    ['{"log":{"entries":[]}}', 'har'],
    ['{"info":{"_postman_id":"x","name":"c"},"item":[]}', 'postman'],
  ])('%s → %s', (text, format) => {
    expect(detectFormat(text)).toBe(format);
  });

  it('rejects unknown and invalid content', () => {
    expect(errorKey(() => detectFormat('{"hello":1}'))).toBe('import.unknownFormat');
    expect(errorKey(() => detectFormat('{"hello":'))).toBe('import.invalidJson');
    expect(errorKey(() => parseImportText('just text'))).toBe('import.unknownFormat');
  });

  it('limits YAML aliases (billion laughs)', () => {
    const bomb = ['a: &a ["x","x","x","x","x","x","x","x","x","x"]', ...Array.from({ length: 8 }, (_, i) => `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(10).fill(`*${String.fromCharCode(97 + i)}`).join(',')}]`)].join('\n');
    expect(() => parseImportText(bomb)).toThrow(ImportError);
  });
});

describe('OpenAPI pass-through', () => {
  it('keeps the spec and derives base URL, name and credential', () => {
    const spec = rhOpenApiSpec('http://localhost:4010');
    const r = parseImportText(JSON.stringify(spec));
    expect(r.format).toBe('openapi');
    expect(r.openapi).toEqual(spec);
    expect(r.baseUrlCandidates).toEqual(['http://localhost:4010']);
    expect(r.suggestedName).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
    expect(r.warnings).toEqual([]);
  });

  it('swagger 2.0 host/basePath and apiKey scheme', () => {
    const r = importDocument({
      swagger: '2.0',
      info: { title: 'Legacy', version: '1' },
      host: 'h.io',
      basePath: '/v1/',
      schemes: ['https'],
      securityDefinitions: { k: { type: 'apiKey', in: 'header', name: 'X-Key' } },
      paths: {},
    });
    expect(r.baseUrlCandidates).toEqual(['https://h.io/v1']);
    expect(r.suggestedCredential).toEqual({ type: 'api_key', in: 'header', name: 'X-Key' });
  });

  it('rejects unsupported versions', () => {
    expect(errorKey(() => importDocument({ openapi: '2.5' }, 'openapi'))).toBe('toolgen.unsupportedSpecVersion');
  });
});

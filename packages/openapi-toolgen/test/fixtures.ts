import { readFileSync } from 'node:fs';
import { rhOpenApiSpec } from '@mcp-gateway/testkit';

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Record<string, unknown>;

export const FIXTURES = {
  'swagger-2.0': () => load('rh-swagger2.json'),
  'oas-3.0': () => load('rh-oas30.json'),
  'oas-3.1': () => rhOpenApiSpec('http://localhost'),
};

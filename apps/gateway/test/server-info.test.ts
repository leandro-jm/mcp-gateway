import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SERVER_INFO } from '../src/mcp/server';

describe('MCP server info', () => {
  it('reports the gateway package version (ADR-019)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(SERVER_INFO).toEqual({ name: 'mcp-gateway', version: pkg.version });
    expect(SERVER_INFO.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

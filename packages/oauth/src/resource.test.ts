import { describe, expect, it } from 'vitest';
import { OAuthProtocolError } from './errors';
import { canonicalMcpResource, defaultMcpResource, issuerOf } from './resource';
import { coversScopes, formatScope, grantableScopes, parseScope } from './scopes';

describe('resource indicators', () => {
  const base = 'https://mcp.example.com';

  it('accepts every MCP surface of the gateway', () => {
    for (const path of ['/mcp', '/mcp/omni', '/mcp/observability', '/mcp/s/rh', '/mcp/s/rh-ops/omni']) {
      expect(canonicalMcpResource(`${base}${path}`, base), path).toBe(`${base}${path}`);
    }
  });

  it('accepts the gateway itself (root metadata)', () => {
    expect(canonicalMcpResource(base, base)).toBe(base);
    expect(canonicalMcpResource(`${base}/`, base)).toBe(base);
  });

  it('canonicalizes a trailing slash and the host case', () => {
    expect(canonicalMcpResource('https://MCP.example.com/mcp/omni/', base)).toBe(`${base}/mcp/omni`);
  });

  it('rejects other servers, paths, queries and fragments', () => {
    for (const raw of [
      'https://evil.example.com/mcp',
      'http://mcp.example.com/mcp',
      'https://mcp.example.com:8443/mcp',
      `${base}/admin/v1`,
      `${base}/mcp/s/../admin`,
      `${base}/mcp/s/UPPER`,
      `${base}/mcpx`,
      `${base}/mcp?x=1`,
      `${base}/mcp#x`,
      'https://user@mcp.example.com/mcp',
      'nope',
    ]) {
      expect(canonicalMcpResource(raw, base), raw).toBeUndefined();
    }
  });

  it('honours a public base path', () => {
    const withPath = 'https://example.com/gateway/';
    expect(issuerOf(withPath)).toBe('https://example.com/gateway');
    expect(canonicalMcpResource('https://example.com/gateway/mcp/omni', withPath)).toBe(
      'https://example.com/gateway/mcp/omni',
    );
    expect(canonicalMcpResource('https://example.com/mcp/omni', withPath)).toBeUndefined();
    expect(canonicalMcpResource('https://example.com/gateway', withPath)).toBe('https://example.com/gateway');
    expect(canonicalMcpResource('https://example.com/', withPath)).toBeUndefined();
    expect(defaultMcpResource(withPath)).toBe('https://example.com/gateway');
  });
});

describe('scopes', () => {
  it('parses space-delimited unique tokens', () => {
    expect(parseScope('mcp  offline_access mcp')).toEqual(['mcp', 'offline_access']);
    expect(parseScope(undefined)).toEqual([]);
    expect(parseScope('  ')).toEqual([]);
  });

  it('rejects malformed scope tokens', () => {
    expect(() => parseScope('mcp "quoted"')).toThrow(OAuthProtocolError);
    expect(() => parseScope('a\\b')).toThrow(OAuthProtocolError);
  });

  it('always grants mcp and drops unknown scopes', () => {
    expect(grantableScopes([])).toEqual(['mcp']);
    expect(grantableScopes(['offline_access', 'admin', 'openid'])).toEqual(['mcp', 'offline_access']);
    expect(formatScope(grantableScopes(['offline_access']))).toBe('mcp offline_access');
  });

  it('checks coverage', () => {
    expect(coversScopes(['mcp', 'offline_access'], ['mcp'])).toBe(true);
    expect(coversScopes(['mcp'], ['mcp', 'offline_access'])).toBe(false);
  });
});

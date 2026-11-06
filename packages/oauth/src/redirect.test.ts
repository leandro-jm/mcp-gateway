import { describe, expect, it } from 'vitest';
import {
  buildRedirect,
  inferApplicationType,
  isAcceptableRedirectUri,
  isLoopbackRedirect,
  redirectUriMatches,
} from './redirect';

describe('isAcceptableRedirectUri', () => {
  it('accepts HTTPS for any client type', () => {
    expect(isAcceptableRedirectUri('https://claude.ai/api/mcp/auth_callback', 'web')).toBe(true);
    expect(isAcceptableRedirectUri('https://claude.ai/api/mcp/auth_callback', 'native')).toBe(true);
  });

  it('accepts plain HTTP only on loopback for native clients', () => {
    expect(isAcceptableRedirectUri('http://127.0.0.1:33418/callback', 'native')).toBe(true);
    expect(isAcceptableRedirectUri('http://[::1]:33418/callback', 'native')).toBe(true);
    expect(isAcceptableRedirectUri('http://localhost/callback', 'native')).toBe(true);
    expect(isAcceptableRedirectUri('http://localhost/callback', 'web')).toBe(false);
    expect(isAcceptableRedirectUri('http://example.com/callback', 'native')).toBe(false);
  });

  it('accepts private-use schemes only for native clients', () => {
    expect(isAcceptableRedirectUri('cursor://anysphere.cursor-mcp/oauth/callback', 'native')).toBe(true);
    expect(isAcceptableRedirectUri('cursor://anysphere.cursor-mcp/oauth/callback', 'web')).toBe(false);
  });

  it('rejects dangerous schemes, fragments, credentials and garbage', () => {
    for (const uri of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      'https://example.com/cb#frag',
      'https://user:pw@example.com/cb',
      'not a url',
      '',
      `https://example.com/${'a'.repeat(2100)}`,
    ]) {
      expect(isAcceptableRedirectUri(uri, 'native'), uri).toBe(false);
    }
  });
});

describe('inferApplicationType', () => {
  it('is native when every redirect stays on the device', () => {
    expect(inferApplicationType(['http://localhost:1234/cb', 'vscode://x/cb'])).toBe('native');
  });

  it('is web as soon as one redirect is a remote HTTPS URL', () => {
    expect(inferApplicationType(['http://localhost:1234/cb', 'https://app.example.com/cb'])).toBe('web');
  });
});

describe('redirectUriMatches', () => {
  it('matches exactly', () => {
    expect(redirectUriMatches(['https://app.example.com/cb'], 'https://app.example.com/cb')).toBe(true);
    expect(redirectUriMatches(['https://app.example.com/cb'], 'https://app.example.com/cb/')).toBe(false);
    expect(redirectUriMatches(['https://app.example.com/cb'], 'https://app.example.com/cb?x=1')).toBe(false);
    expect(redirectUriMatches(['https://app.example.com/cb'], 'https://evil.example.com/cb')).toBe(false);
  });

  it('lets only the port vary on loopback (RFC 8252 §7.3)', () => {
    expect(redirectUriMatches(['http://127.0.0.1/callback'], 'http://127.0.0.1:51234/callback')).toBe(true);
    expect(redirectUriMatches(['http://localhost:3000/callback'], 'http://localhost:4567/callback')).toBe(true);
    expect(redirectUriMatches(['http://127.0.0.1/callback'], 'http://127.0.0.1:51234/other')).toBe(false);
    expect(redirectUriMatches(['http://127.0.0.1/callback'], 'http://localhost:51234/callback')).toBe(false);
    expect(redirectUriMatches(['http://127.0.0.1/callback'], 'https://127.0.0.1:51234/callback')).toBe(false);
  });

  it('never relaxes the port for non-loopback hosts', () => {
    expect(redirectUriMatches(['https://app.example.com/cb'], 'https://app.example.com:8443/cb')).toBe(false);
  });
});

describe('helpers', () => {
  it('detects loopback redirects', () => {
    expect(isLoopbackRedirect('http://127.0.0.1:9/cb')).toBe(true);
    expect(isLoopbackRedirect('https://claude.ai/cb')).toBe(false);
    expect(isLoopbackRedirect('cursor://x/cb')).toBe(false);
  });

  it('appends response parameters and keeps the original query', () => {
    const url = new URL(buildRedirect('https://app.example.com/cb?tenant=a', { code: 'c', state: 's&x', iss: undefined }));
    expect(url.searchParams.get('tenant')).toBe('a');
    expect(url.searchParams.get('code')).toBe('c');
    expect(url.searchParams.get('state')).toBe('s&x');
    expect(url.searchParams.has('iss')).toBe(false);
  });
});

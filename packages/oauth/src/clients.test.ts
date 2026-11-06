import { describe, expect, it } from 'vitest';
import { cleanClientName, clientMetadataHost, isClientMetadataUrl, parseClientMetadataDocument } from './client-metadata';
import { OAuthProtocolError } from './errors';
import { parseRegistrationRequest, registrationResponse } from './registration';

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof OAuthProtocolError) return `${err.code}/${err.reason}`;
    throw err;
  }
  return undefined;
}

describe('isClientMetadataUrl', () => {
  it('accepts canonical HTTPS URLs with a path', () => {
    expect(isClientMetadataUrl('https://claude.ai/oauth/mcp-oauth-client-metadata')).toBe(true);
  });

  it('rejects anything that could alias another client', () => {
    for (const id of [
      'http://claude.ai/meta',
      'https://claude.ai',
      'https://claude.ai/',
      'https://CLAUDE.ai/meta',
      'https://claude.ai/a/../meta',
      'https://claude.ai:443/meta',
      'https://claude.ai/meta?x=1',
      'https://claude.ai/meta#x',
      'https://u:p@claude.ai/meta',
      'f3a1c2-dcr-client',
    ]) {
      expect(isClientMetadataUrl(id), id).toBe(false);
    }
  });

  it('exposes the host for display and policies', () => {
    expect(clientMetadataHost('https://claude.ai/oauth/meta')).toBe('claude.ai');
  });
});

describe('parseClientMetadataDocument', () => {
  const id = 'https://app.example.com/oauth/client.json';
  const doc = { client_id: id, client_name: 'Example', redirect_uris: ['https://app.example.com/cb'] };

  it('accepts a valid document', () => {
    expect(parseClientMetadataDocument(doc, id)).toEqual({
      clientId: id,
      kind: 'cimd',
      clientName: 'Example',
      redirectUris: ['https://app.example.com/cb'],
      applicationType: 'web',
      clientUri: undefined,
    });
  });

  it('infers a native client from loopback redirects', () => {
    const parsed = parseClientMetadataDocument({ ...doc, redirect_uris: ['http://127.0.0.1/callback'] }, id);
    expect(parsed.applicationType).toBe('native');
  });

  it('falls back to the host when the name is missing or blank', () => {
    expect(parseClientMetadataDocument({ ...doc, client_name: ' \u0000 ' }, id).clientName).toBe('app.example.com');
  });

  it('rejects documents that do not describe this client', () => {
    expect(reasonOf(() => parseClientMetadataDocument({ ...doc, client_id: 'https://other.example.com/c' }, id))).toBe(
      'invalid_client/client_id_mismatch',
    );
    expect(reasonOf(() => parseClientMetadataDocument({ client_id: id }, id))).toBe('invalid_client/invalid_client_metadata');
    expect(reasonOf(() => parseClientMetadataDocument('nope', id))).toBe('invalid_client/invalid_client_metadata');
  });

  it('rejects confidential clients and unsupported flows', () => {
    expect(reasonOf(() => parseClientMetadataDocument({ ...doc, token_endpoint_auth_method: 'private_key_jwt' }, id))).toBe(
      'invalid_client/unsupported_auth_method',
    );
    expect(reasonOf(() => parseClientMetadataDocument({ ...doc, grant_types: ['client_credentials'] }, id))).toBe(
      'invalid_client/unsupported_grant_types',
    );
    expect(reasonOf(() => parseClientMetadataDocument({ ...doc, response_types: ['token'] }, id))).toBe(
      'invalid_client/unsupported_response_type',
    );
  });

  it('rejects unacceptable redirects', () => {
    expect(
      reasonOf(() => parseClientMetadataDocument({ ...doc, application_type: 'web', redirect_uris: ['http://localhost/cb'] }, id)),
    ).toBe('invalid_client/invalid_redirect_uri');
    expect(reasonOf(() => parseClientMetadataDocument({ ...doc, redirect_uris: ['javascript:alert(1)'] }, id))).toBe(
      'invalid_client/invalid_redirect_uri',
    );
  });
});

describe('parseRegistrationRequest', () => {
  it('registers a native CLI client without an application type', () => {
    const req = parseRegistrationRequest({
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost:51234/callback'],
      token_endpoint_auth_method: 'none',
    });
    expect(req).toEqual({
      clientName: 'Claude Code',
      clientUri: undefined,
      redirectUris: ['http://localhost:51234/callback'],
      applicationType: 'native',
      grantTypes: ['authorization_code', 'refresh_token'],
    });
  });

  it('overrides a confidential auth method with none', () => {
    const req = parseRegistrationRequest({
      redirect_uris: ['https://app.example.com/cb'],
      token_endpoint_auth_method: 'client_secret_post',
    });
    const res = registrationResponse('dcr_abc', new Date('2026-11-06T00:00:00Z'), req);
    expect(res.token_endpoint_auth_method).toBe('none');
    expect(res).not.toHaveProperty('client_secret');
    expect(res.client_id_issued_at).toBe(1793923200);
  });

  it('keeps only supported grant types', () => {
    const req = parseRegistrationRequest({
      redirect_uris: ['https://app.example.com/cb'],
      grant_types: ['authorization_code', 'implicit'],
    });
    expect(req.grantTypes).toEqual(['authorization_code']);
  });

  it('rejects invalid metadata with RFC 7591 codes', () => {
    expect(reasonOf(() => parseRegistrationRequest({}))).toBe('invalid_redirect_uri/invalid_redirect_uri');
    expect(reasonOf(() => parseRegistrationRequest({ redirect_uris: ['http://example.com/cb'] }))).toBe(
      'invalid_redirect_uri/invalid_redirect_uri',
    );
    expect(
      reasonOf(() => parseRegistrationRequest({ application_type: 'web', redirect_uris: ['http://127.0.0.1/cb'] })),
    ).toBe('invalid_redirect_uri/invalid_redirect_uri');
    expect(reasonOf(() => parseRegistrationRequest({ redirect_uris: ['https://a.example/cb'], grant_types: ['implicit'] }))).toBe(
      'invalid_client_metadata/unsupported_grant_types',
    );
    expect(reasonOf(() => parseRegistrationRequest({ redirect_uris: ['https://a.example/cb'], application_type: 'tv' }))).toBe(
      'invalid_client_metadata/invalid_client_metadata',
    );
    expect(reasonOf(() => parseRegistrationRequest({ redirect_uris: ['https://a.example/cb'], client_name: 7 }))).toBe(
      'invalid_client_metadata/invalid_client_metadata',
    );
  });

  it('cleans self-declared names', () => {
    expect(cleanClientName('  Evil\u202eClient\u0007 ')).toBe('EvilClient');
    expect(cleanClientName('x'.repeat(500))).toHaveLength(200);
  });
});

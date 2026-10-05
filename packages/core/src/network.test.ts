import { describe, expect, it } from 'vitest';
import { translate } from '@mcp-gateway/i18n/server';
import { assertOutboundUrl, effectiveNetworkPolicy, expandIPv6, isIP, isPrivateAddress, OutboundBlocked } from './network';

describe('network policy (SSRF)', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.32.0.1', false],
    ['192.168.10.10', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['8.8.8.8', false],
    ['::1', true],
    ['fd00::1', true],
    ['fe80::1', true],
    ['::ffff:127.0.0.1', true],
    ['2001:4860:4860::8888', false],
    // IPv4 embedded in IPv6, in the hex form the URL parser produces
    ['::ffff:7f00:1', true],
    ['::ffff:a9fe:a9fe', true],
    ['0:0:0:0:0:ffff:a00:1', true],
    ['::ffff:808:808', false],
    ['::7f00:1', true],
    ['::ffff:0:7f00:1', true],
    ['64:ff9b::a9fe:a9fe', true],
    ['64:ff9b::808:808', false],
    ['64:ff9b:1::1', true],
    ['2002:7f00:1::', true],
    ['2002:808:808::1', false],
    ['2001::1', true],
    ['2001:db8::1', true],
    ['fec0::1', true],
    ['::', true],
    ['fe80::1%eth0', true],
    ['1::2::3', true],
  ])('%s private=%s', (ip, priv) => expect(isPrivateAddress(ip)).toBe(priv));

  it('expandIPv6', () => {
    expect(expandIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(expandIPv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(expandIPv6('1:2:3:4:5:6:7')).toBeUndefined();
    expect(expandIPv6('1::2::3')).toBeUndefined();
    expect(expandIPv6('fe80::1%eth0')).toBeUndefined();
    expect(expandIPv6('::ffff:999.1.1.1')).toBeUndefined();
  });

  it.each(['http://[::ffff:127.0.0.1]/', 'http://[::ffff:169.254.169.254]/latest/meta-data/', 'http://[::127.0.0.1]/', 'http://[64:ff9b::a9fe:a9fe]/', 'http://[2002:a9fe:a9fe::]/'])(
    'blocks the IPv6 form of a private IPv4: %s',
    (url) => expect(() => assertOutboundUrl(url, { allowPrivate: false, allowedHosts: [] })).toThrow(/private/),
  );

  it('isIP', () => {
    expect(isIP('1.2.3.4')).toBe(4);
    expect(isIP('256.1.1.1')).toBe(0);
    expect(isIP('::1')).toBe(6);
    expect(isIP('api.empresa.com')).toBe(0);
  });

  it('blocks protocol, credentials, private IPs and internal hosts; applies the allowlist', () => {
    const pub = { allowPrivate: false, allowedHosts: [] };
    expect(() => assertOutboundUrl('file:///etc/passwd', pub)).toThrow(/protocol/);
    expect(() => assertOutboundUrl('http://user:pw@api.x.com', pub)).toThrow(/credentials/);
    expect(() => assertOutboundUrl('http://169.254.169.254/latest/meta-data', pub)).toThrow(/private/);
    expect(() => assertOutboundUrl('http://[::1]:8080', pub)).toThrow(/private/);
    expect(() => assertOutboundUrl('http://localhost:4010', pub)).toThrow(/internal/);
    expect(assertOutboundUrl('https://api.empresa.com/v1', pub).host).toBe('api.empresa.com');
    const allow = { allowPrivate: false, allowedHosts: ['*.empresa.com.br'] };
    expect(() => assertOutboundUrl('https://evil.com', allow)).toThrow(/allowlist/);
    expect(assertOutboundUrl('https://rh.empresa.com.br', allow).hostname).toBe('rh.empresa.com.br');
    expect(assertOutboundUrl('http://127.0.0.1:4010', { allowPrivate: true, allowedHosts: [] }).port).toBe('4010');
  });

  it('carries a translatable reason', () => {
    let err: unknown;
    try {
      assertOutboundUrl('http://localhost:4010', { allowPrivate: false, allowedHosts: [] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OutboundBlocked);
    const blocked = err as OutboundBlocked;
    expect(blocked.message).toBe('internal host not allowed: localhost');
    expect(translate(blocked.msg, 'pt-BR')).toBe('host interno não permitido: localhost');
    expect(translate(blocked.msg, 'es')).toBe('host interno no permitido: localhost');
  });

  it('the tenant restricts but does not loosen the environment', () => {
    expect(effectiveNetworkPolicy(false, { network: { allowPrivate: true } }).allowPrivate).toBe(false);
    expect(effectiveNetworkPolicy(true, { network: { allowPrivate: false } }).allowPrivate).toBe(false);
    expect(effectiveNetworkPolicy(true, {}).allowPrivate).toBe(true);
    expect(effectiveNetworkPolicy(true, { network: { allowedHosts: ['a.com'] } }).allowedHosts).toEqual(['a.com']);
  });
});

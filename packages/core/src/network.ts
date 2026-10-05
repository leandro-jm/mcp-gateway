import { msg, translate, type ServerMessage } from '@mcp-gateway/i18n/server';
import { globMatch } from './glob';

const V4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * 4 = IPv4, 6 = IPv6, 0 = not an IP literal (no `node:net`, pure package).
 * Anything with a colon counts as IPv6: hostnames cannot contain one, and a malformed literal
 * must reach `isPrivateAddress` (which fails closed) instead of passing as a hostname.
 */
export function isIP(value: string): 0 | 4 | 6 {
  if (V4_RE.test(value)) return 4;
  if (value.includes(':')) return 6;
  return 0;
}

/**
 * Expands an IPv6 literal (`::` compression and dotted IPv4 tail included) into 8 hextets.
 * Returns undefined for malformed literals and zone ids (`fe80::1%eth0`).
 */
export function expandIPv6(ip: string): number[] | undefined {
  let s = ip.toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(s)) return undefined;
  let tail: number[] = [];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    if (!V4_RE.test(v4[1]!)) return undefined;
    const n = v4ToInt(v4[1]!);
    tail = [n >>> 16, n & 0xffff];
    s = s.slice(0, -v4[1]!.length);
    if (!s.endsWith('::')) {
      if (!s.endsWith(':')) return undefined;
      s = s.slice(0, -1);
    }
  }
  if (s.includes('.')) return undefined;
  const parts = s.split('::');
  if (parts.length > 2) return undefined;
  const parse = (p: string) => (p === '' ? [] : p.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
  const head = parse(parts[0]!);
  const want = 8 - tail.length;
  let groups: number[];
  if (parts.length === 1) {
    if (head.length !== want) return undefined;
    groups = head;
  } else {
    const rest = parse(parts[1]!);
    const fill = want - head.length - rest.length;
    if (fill < 1) return undefined;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  }
  if (groups.some(Number.isNaN)) return undefined;
  return [...groups, ...tail];
}

/** Outbound network policy (SSRF, F11.1). */
export interface NetworkPolicy {
  /** Allows destinations in private/loopback/link-local networks (default: no). */
  allowPrivate: boolean;
  /** Allowed hosts (globs, e.g. `*.empresa.com.br`). Empty = any public host. */
  allowedHosts: string[];
}

/**
 * Outbound request blocked by the network policy. `msg` is the translatable reason (use it as a
 * nested param when wrapping in a user-facing error); `message` is English, for logs.
 */
export class OutboundBlocked extends Error {
  constructor(readonly msg: ServerMessage) {
    super(translate(msg));
    this.name = 'OutboundBlocked';
  }
}

/**
 * Connection-time block: the host resolved to a private address (DNS rebinding guard). The
 * address stays out of the message (it reaches the agent) and goes in `address`, for logs.
 */
export function resolvesToPrivate(address: string): OutboundBlocked & { address: string } {
  return Object.assign(new OutboundBlocked(msg('config.outboundResolvesPrivate')), { address });
}

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const V4_PRIVATE: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/** Non-public address (loopback, private, link-local, CGNAT, multicast, reserved). */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const n = v4ToInt(ip);
    return V4_PRIVATE.some(([base, bits]) => (n >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits)));
  }
  if (kind === 6) {
    const h = expandIPv6(ip);
    if (!h) return true; // malformed literal or zone id: fail closed
    const zero = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
    const v4At = (i: number) => `${h[i]! >> 8}.${h[i]! & 0xff}.${h[i + 1]! >> 8}.${h[i + 1]! & 0xff}`;
    if (zero(0, 6)) return true; // ::, ::1 and ::a.b.c.d (deprecated IPv4-compatible)
    if (zero(0, 5) && h[5] === 0xffff) return isPrivateAddress(v4At(6)); // ::ffff:0:0/96 (IPv4-mapped)
    if (zero(0, 4) && h[4] === 0xffff && h[5] === 0) return true; // ::ffff:0:0:0/96 (SIIT)
    if (h[0] === 0x64 && h[1] === 0xff9b && zero(2, 6)) return isPrivateAddress(v4At(6)); // 64:ff9b::/96 (NAT64)
    if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return true; // 64:ff9b:1::/48 (local NAT64)
    if (h[0] === 0x2002) return isPrivateAddress(v4At(1)); // 2002::/16 (6to4)
    if (h[0] === 0x2001 && (h[1] === 0 || h[1] === 0xdb8)) return true; // Teredo, documentation
    if (h[0] === 0x100 && zero(1, 4)) return true; // 100::/64 (discard)
    const first = h[0]!;
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
    if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 (site-local, deprecated)
    if ((first & 0xff00) === 0xff00) return true; // multicast
    return false;
  }
  return false;
}

/**
 * Validates an outbound URL without resolving DNS (the resolved IPs are checked on
 * connect, to prevent DNS rebinding).
 */
export function assertOutboundUrl(raw: string, policy: NetworkPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundBlocked(msg('config.outboundInvalidUrl', { url: raw }));
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new OutboundBlocked(msg('config.outboundProtocol', { protocol: url.protocol }));
  if (url.username || url.password) throw new OutboundBlocked(msg('config.outboundCredentials'));
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (policy.allowedHosts.length && !policy.allowedHosts.some((p) => globMatch(p.toLowerCase(), host))) {
    throw new OutboundBlocked(msg('config.outboundNotAllowlisted', { host }));
  }
  if (!policy.allowPrivate) {
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host === 'metadata.google.internal') {
      throw new OutboundBlocked(msg('config.outboundInternalHost', { host }));
    }
    if (isIP(host) && isPrivateAddress(host)) throw new OutboundBlocked(msg('config.outboundPrivateAddress', { host }));
  }
  return url;
}

/** Effective policy: the tenant may restrict, never loosen what the environment forbids. */
export function effectiveNetworkPolicy(envAllowPrivate: boolean, tenantSettings: unknown): NetworkPolicy {
  const n = ((tenantSettings ?? {}) as { network?: { allowPrivate?: unknown; allowedHosts?: unknown } }).network ?? {};
  const allowedHosts = Array.isArray(n.allowedHosts) ? n.allowedHosts.filter((h): h is string => typeof h === 'string') : [];
  return { allowPrivate: envAllowPrivate && n.allowPrivate !== false, allowedHosts };
}

import { randomUUID } from 'node:crypto';

/**
 * Stateless session id (ADR-016 §10): issued on `initialize` and echoed by spec-compliant clients
 * on every request. It carries the client's self-declared `clientInfo`, so later calls know the
 * agent without server state. Not signed: `clientInfo` is self-declared anyway, and the session
 * key is always bound to the caller's `sub` (`sessionKeyOf`).
 */
export const SESSION_ID_PREFIX = 'mgs1_';
const MAX_ID_LENGTH = 256;
const MAX_NAME = 64;
const MAX_VERSION = 32;

export interface AgentInfo {
  name?: string;
  version?: string;
}

export interface ParsedSessionId extends AgentInfo {
  sid: string;
}

/** Keeps printable characters only and truncates. */
function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  return v || undefined;
}

/** `clientInfo` from an `initialize` request body (single message or batch). */
export function clientInfoOf(body: unknown): AgentInfo | undefined {
  const messages = Array.isArray(body) ? body : [body];
  for (const m of messages) {
    const msg = m as { method?: unknown; params?: { clientInfo?: { name?: unknown; version?: unknown } } } | null;
    if (msg?.method !== 'initialize') continue;
    const info = msg.params?.clientInfo;
    const name = clean(info?.name, MAX_NAME);
    const version = clean(info?.version, MAX_VERSION);
    return { ...(name ? { name } : {}), ...(version ? { version } : {}) };
  }
  return undefined;
}

export function isInitialize(body: unknown): boolean {
  return clientInfoOf(body) !== undefined;
}

export function issueSessionId(agent: AgentInfo = {}): string {
  const payload: Record<string, string> = { sid: randomUUID() };
  if (agent.name) payload.cn = agent.name;
  if (agent.version) payload.cv = agent.version;
  let id = SESSION_ID_PREFIX + Buffer.from(JSON.stringify(payload)).toString('base64url');
  // never exceed the cap: drop the version, then the name
  if (id.length > MAX_ID_LENGTH) id = SESSION_ID_PREFIX + Buffer.from(JSON.stringify({ sid: payload.sid })).toString('base64url');
  return id;
}

export function isStatelessSessionId(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.startsWith(SESSION_ID_PREFIX);
}

/** Parses an `mgs1_` id; anything malformed yields `undefined` (the call still works, without agent info). */
export function parseSessionId(raw: unknown): ParsedSessionId | undefined {
  if (!isStatelessSessionId(raw) || raw.length > MAX_ID_LENGTH) return undefined;
  const body = raw.slice(SESSION_ID_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return undefined;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { sid?: unknown; cn?: unknown; cv?: unknown };
    const sid = clean(p.sid, 64);
    if (!sid) return undefined;
    const name = clean(p.cn, MAX_NAME);
    const version = clean(p.cv, MAX_VERSION);
    return { sid, ...(name ? { name } : {}), ...(version ? { version } : {}) };
  } catch {
    return undefined;
  }
}

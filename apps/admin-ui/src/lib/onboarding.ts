import { useCallback, useSyncExternalStore } from 'react';
import { useSession } from '../api/session';
import type { ApiToken, CallSummary, Credential, Page, Policy, Source } from '../api/types';
import { useTenantQuery } from './hooks';

/**
 * Getting-started checklist (ADR-023). Every step is detected from data the Admin API already
 * exposes; steps that cannot be observed (or that do not apply, e.g. an API without auth) can
 * also be marked by hand, kept in localStorage per tenant and user.
 */

export type StepId = 'credential' | 'source' | 'crawl' | 'enable' | 'policy' | 'playground' | 'token' | 'connect';
export type ExtraId = 'server' | 'pii' | 'projection' | 'composite' | 'observability';
/** Who can perform the step: a tenant admin only, or a tool owner too, or anyone. */
export type Who = 'admin' | 'owner' | 'any';

export interface StepStatus<Id extends string = StepId> {
  id: Id;
  to: string;
  who: Who;
  /** The current user can perform the step. */
  canDo: boolean;
  /** Detected from the tenant data. */
  detected: boolean;
  /** Marked as done by hand. */
  marked: boolean;
  /** The step accepts being marked by hand. */
  manual: boolean;
  done: boolean;
}

interface StoredState {
  manual: string[];
  dismissed: boolean;
}

const EMPTY: StoredState = { manual: [], dismissed: false };
const listeners = new Set<() => void>();
const cache = new Map<string, StoredState>();

function read(key: string): StoredState {
  const hit = cache.get(key);
  if (hit) return hit;
  let state = EMPTY;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredState>;
      state = { manual: Array.isArray(parsed.manual) ? parsed.manual.filter((m) => typeof m === 'string') : [], dismissed: parsed.dismissed === true };
    }
  } catch {
    /* storage unavailable */
  }
  cache.set(key, state);
  return state;
}

function write(key: string, state: StoredState) {
  cache.set(key, state);
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const STEPS: Array<{ id: StepId; to: string; who: Who; manual?: boolean }> = [
  { id: 'credential', to: '/sources', who: 'admin', manual: true },
  { id: 'source', to: '/sources', who: 'admin' },
  { id: 'crawl', to: '/sources', who: 'owner' },
  { id: 'enable', to: '/tools', who: 'owner' },
  { id: 'policy', to: '/policies', who: 'admin' },
  { id: 'playground', to: '/playground', who: 'owner', manual: true },
  { id: 'token', to: '/tokens', who: 'any', manual: true },
  { id: 'connect', to: '/calls', who: 'any' },
];

const EXTRAS: Array<{ id: ExtraId; to: string; who: Who; manual?: boolean }> = [
  { id: 'server', to: '/servers', who: 'owner' },
  { id: 'pii', to: '/pii', who: 'admin' },
  { id: 'projection', to: '/projections', who: 'owner', manual: true },
  { id: 'composite', to: '/composer', who: 'owner' },
  { id: 'observability', to: '/observability', who: 'any', manual: true },
];

/**
 * Progress of the getting-started guide. `live` (the guide page itself) also loads the optional
 * steps and polls the tenant data, so the checks turn green while the user works in another tab
 * (e.g. the first agent call); the shell and the home redirect only need the essential steps.
 */
export function useOnboarding({ live = false }: { live?: boolean } = {}) {
  const { me, tenant } = useSession();
  const opts = { refetchMs: live ? 15_000 : 0 };
  const canRead = me.isAdmin || me.isOwner;
  const path = (p: string) => (canRead ? p : null);

  const credentials = useTenantQuery<{ items: Credential[] }>(['onboarding', 'credentials'], me.isAdmin ? '/credentials' : null, opts);
  const sources = useTenantQuery<Page<Source>>(['onboarding', 'sources'], path('/sources?limit=100'), opts);
  const tools = useTenantQuery<Page<unknown>>(['onboarding', 'tools'], path('/tools?limit=1'), opts);
  const enabled = useTenantQuery<Page<unknown>>(['onboarding', 'tools-enabled'], path('/tools?state=enabled&limit=1'), opts);
  const policies = useTenantQuery<{ items: Policy[] }>(['onboarding', 'policies'], path('/policies'), opts);
  const calls = useTenantQuery<{ items: CallSummary[] }>(['onboarding', 'calls'], path('/calls?decision=allow&limit=200'), opts);
  const tokens = useTenantQuery<{ items: ApiToken[] }>(['onboarding', 'tokens'], '/me/tokens', opts);
  const extra = (p: string) => (live ? path(p) : null);
  const servers = useTenantQuery<{ items: unknown[] }>(['onboarding', 'servers'], extra('/virtual-servers'), opts);
  const pii = useTenantQuery<{ items: unknown[] }>(['onboarding', 'pii'], extra('/pii-rules'), opts);
  const composites = useTenantQuery<{ items: unknown[] }>(['onboarding', 'composites'], extra('/composites'), opts);

  const key = `mcp-gw:onboarding:${tenant ?? '-'}:${me.sub}`;
  const stored = useSyncExternalStore(subscribe, () => read(key));

  const toolCalls = calls.data?.items.filter((c) => c.kind === 'tool') ?? [];
  const detected: Record<StepId | ExtraId, boolean> = {
    credential: (credentials.data?.items.length ?? 0) > 0 || (sources.data?.items.some((s) => s.credentialId) ?? false),
    source: (sources.data?.total ?? 0) > 0,
    crawl: (tools.data?.total ?? 0) > 0,
    enable: (enabled.data?.total ?? 0) > 0,
    policy: policies.data?.items.some((p) => p.effect === 'allow') ?? false,
    playground: toolCalls.some((c) => c.endpoint === 'playground'),
    token: (tokens.data?.items.length ?? 0) > 0,
    connect: toolCalls.some((c) => c.endpoint !== 'playground'),
    server: (servers.data?.items.length ?? 0) > 0,
    pii: (pii.data?.items.length ?? 0) > 0,
    projection: false,
    composite: (composites.data?.items.length ?? 0) > 0,
    observability: false,
  };

  const canDo = (who: Who) => (who === 'admin' ? me.isAdmin : who === 'owner' ? me.isAdmin || me.isOwner : true);
  const status = <Id extends StepId | ExtraId>(s: { id: Id; to: string; who: Who; manual?: boolean }): StepStatus<Id> => {
    const marked = Boolean(s.manual) && stored.manual.includes(s.id);
    return { id: s.id, to: s.to, who: s.who, canDo: canDo(s.who), detected: detected[s.id], marked, manual: Boolean(s.manual), done: detected[s.id] || marked };
  };

  const steps = STEPS.map(status);
  const extras = EXTRAS.map(status);
  const done = steps.filter((s) => s.done).length;

  const setMarked = useCallback(
    (id: StepId | ExtraId, value: boolean) => {
      const cur = read(key);
      const manual = value ? [...new Set([...cur.manual, id])] : cur.manual.filter((m) => m !== id);
      write(key, { ...cur, manual });
    },
    [key],
  );
  const setDismissed = useCallback((dismissed: boolean) => write(key, { ...read(key), dismissed }), [key]);

  const queries = [credentials, sources, tools, enabled, policies, calls, tokens];
  return {
    steps,
    extras,
    done,
    total: steps.length,
    essentialComplete: done === steps.length,
    isLoading: queries.some((q) => q.isLoading),
    dismissed: stored.dismissed,
    setMarked,
    setDismissed,
  };
}

/** Connection snippets for the tenant's omni endpoint (same format as the virtual-server snippets). */
export function omniSnippets(publicUrl: string) {
  const url = `${publicUrl.replace(/\/$/, '')}/mcp/omni`;
  return {
    url,
    claude: `claude mcp add --transport http mcp-gateway ${url} --header "Authorization: Bearer $MCP_GATEWAY_TOKEN"`,
    claudeJson: JSON.stringify({ mcpServers: { 'mcp-gateway': { type: 'http', url, headers: { Authorization: 'Bearer ${MCP_GATEWAY_TOKEN}' } } } }, null, 2),
    curl: [
      `curl -s ${url} -H "Authorization: Bearer $MCP_GATEWAY_TOKEN" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \\`,
      `  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"cli","version":"1"}}}'`,
    ].join('\n'),
  };
}

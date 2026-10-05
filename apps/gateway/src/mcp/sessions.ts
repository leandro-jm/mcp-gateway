import { randomUUID } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallContext } from '../proxy/executor';
import type { OmniSession } from './omni';

export interface McpSession {
  id: string;
  transport: StreamableHTTPServerTransport;
  server: Server;
  /** Session owner: only the same subject/tenant can reuse it. */
  owner: { tenantId: string; sub: string; path: string };
  ctx: CallContext;
  omni: OmniSession;
  lastSeen: number;
  /** `clientInfo` declared on `initialize` (ADR-016 §10). */
  agent?: { name?: string; version?: string };
}

/**
 * Stateful MCP sessions (Omni dynamic mode). They live in the process memory:
 * in a multi-replica deploy, the load balancer needs `mcp-session-id` affinity (ADR-009).
 */
export class SessionStore {
  private readonly sessions = new Map<string, McpSession>();
  private readonly timer: NodeJS.Timeout;

  /**
   * Sessions live in memory: per-subject and total caps bound it. When full, the least recently
   * used session (of the subject, or overall) is closed instead of refusing the new one.
   */
  constructor(
    private readonly idleMs = 30 * 60_000,
    private readonly maxPerSubject = 20,
    private readonly maxTotal = 10_000,
  ) {
    this.timer = setInterval(() => this.sweep(), Math.min(idleMs, 60_000));
    this.timer.unref();
  }

  private evictFor(owner: McpSession['owner']): void {
    const oldest = (list: McpSession[]) => list.reduce((a, b) => (b.lastSeen < a.lastSeen ? b : a));
    const mine = [...this.sessions.values()].filter((s) => s.owner.tenantId === owner.tenantId && s.owner.sub === owner.sub);
    if (mine.length >= this.maxPerSubject) this.drop(oldest(mine));
    if (this.sessions.size >= this.maxTotal) this.drop(oldest([...this.sessions.values()]));
  }

  private drop(s: McpSession): void {
    this.sessions.delete(s.id);
    void s.transport.close().catch(() => undefined);
  }

  get(id: string): McpSession | undefined {
    return this.sessions.get(id);
  }

  async create(
    owner: McpSession['owner'],
    ctx: CallContext,
    omni: OmniSession,
    build: (getCtx: () => CallContext) => Server,
  ): Promise<McpSession> {
    this.evictFor(owner);
    const session: McpSession = {
      id: '',
      transport: undefined as unknown as StreamableHTTPServerTransport,
      server: undefined as unknown as Server,
      owner,
      ctx,
      omni,
      lastSeen: Date.now(),
    };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        session.id = id;
        this.sessions.set(id, session);
      },
      onsessionclosed: (id) => {
        this.sessions.delete(id);
      },
    });
    session.transport = transport;
    session.server = build(() => session.ctx);
    transport.onclose = () => {
      if (session.id) this.sessions.delete(session.id);
    };
    await session.server.connect(transport);
    return session;
  }

  private sweep(): void {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (now - s.lastSeen > this.idleMs) this.drop(s);
    }
  }

  async closeAll(): Promise<void> {
    clearInterval(this.timer);
    await Promise.all([...this.sessions.values()].map((s) => s.transport.close().catch(() => undefined)));
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }
}

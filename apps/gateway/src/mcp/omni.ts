import type { Locale } from '@mcp-gateway/i18n';
import { msg, translate, type ServerMessage, type ServerMessageKey } from '@mcp-gateway/i18n/server';
import { ProtocolError as McpProtocolError, Server } from '@modelcontextprotocol/server';
import { descriptorTokens, shortHash } from '@mcp-gateway/call-analytics';
import type { ArtifactService } from '../proxy/artifacts';
import type { CallRecorder } from '../telemetry/call-events/recorder';
import { forRequest, requestInfo } from './call-context';
import { outcomeToolEnabled, REPORT_OUTCOME, reportOutcomeTool, type OutcomeHandler } from './outcomes';
import { artifactResources, artifactTools, callArtifactTool, isArtifactTool } from './artifact-tools';
import { registerResources, uiResources } from './resources';
import { activeProjection, ProtocolError, toDescriptor, type CallContext, type ToolExecutor } from '../proxy/executor';
import { describeTool } from '../proxy/effect';
import { errorResult, type ToolResult } from '../proxy/result';
import type { ToolSearch } from '../search/tool-search';
import { SERVER_INFO } from './server';

/** Omni meta-tool definitions, in the session locale. */
export function omniTools(locale: Locale) {
  const t = (key: ServerMessageKey) => translate(msg(key), locale);
  return [
    {
      name: 'search_tools',
      title: t('mcp.searchToolsTitle'),
      description: t('mcp.searchToolsDescription'),
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: t('mcp.searchToolsQueryDescription') },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_tool_schema',
      title: t('mcp.getToolSchemaTitle'),
      description: t('mcp.getToolSchemaDescription'),
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: t('mcp.getToolSchemaNameDescription') } },
        required: ['name'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'call_tool',
      title: t('mcp.callToolTitle'),
      description: t('mcp.callToolDescription'),
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          arguments: { type: 'object', description: t('mcp.callToolArgumentsDescription'), additionalProperties: true },
        },
        required: ['name'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
  ];
}

export const OMNI_TOOL_NAMES = ['search_tools', 'get_tool_schema', 'call_tool'] as const;

const META_NAMES = new Set<string>(OMNI_TOOL_NAMES);

function short(text: string, max = 180): string {
  const first = text.split(/(?<=[.!?])\s/)[0] ?? text;
  const s = first.length < 40 ? text : first;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function ok(structured: Record<string, unknown>, text?: string): ToolResult {
  return { content: [{ type: 'text', text: text ?? JSON.stringify(structured) }], structuredContent: structured };
}

/** Dynamic mode state: tools found by the search become native tools of the session. */
export interface OmniSession {
  dynamic: boolean;
  discovered: Set<string>;
}

export interface OmniDeps {
  executor: ToolExecutor;
  search: ToolSearch;
  artifacts?: ArtifactService;
  /** `report_outcome` meta-tool (F15.22), when the tenant enables it. */
  outcomes?: OutcomeHandler;
}

/**
 * Omni server (F7.2): exposes only 3 meta-tools (incremental search). In dynamic mode,
 * the `search_tools` result is added to the session and the client receives
 * `notifications/tools/list_changed`.
 */
export function createOmniServer(deps: OmniDeps, getCtx: () => CallContext, session: OmniSession): Server {
  const vs = getCtx().virtualServer;
  // The language is fixed when the server is created: a dynamic-mode session keeps the locale
  // its principal had at `initialize`, even if the user changes it mid-session (ADR-012).
  const locale = getCtx().principal.locale;
  const current = (): CallContext => {
    const c = getCtx();
    return c.principal.locale === locale ? c : { ...c, principal: { ...c.principal, locale } };
  };
  const text = (m: ServerMessage) => translate(m, locale);
  const fail = (error: string, m: ServerMessage) => errorResult({ error, message: text(m) }) as never;
  const server = new Server(
    { ...SERVER_INFO, name: vs ? `mcp-gateway/${vs.slug}/omni` : 'mcp-gateway/omni', ...(vs?.name ? { title: `${vs.name} (Omni)` } : {}) },
    {
      capabilities: { tools: { listChanged: true }, resources: {} },
      instructions:
        `${(vs?.instructions ?? vs?.description) ? `${vs!.instructions ?? vs!.description}\n\n` : ''}` +
        text(msg('mcp.omniInstructions')) +
        (session.dynamic ? ` ${text(msg('mcp.omniInstructionsDynamic'))}` : ''),
    },
  );

  const visible = () => new Map(deps.executor.listTools(current()).map((d) => [d.name, d]));

  server.setRequestHandler('tools/list', async (_req, h) => {
    const tools: unknown[] = [
      ...omniTools(locale),
      ...(deps.artifacts?.enabled ? artifactTools(locale) : []),
      ...(deps.outcomes && outcomeToolEnabled(current(), 'omni') ? [reportOutcomeTool(locale)] : []),
    ];
    const all = visible();
    if (session.dynamic && session.discovered.size) {
      for (const name of session.discovered) {
        const d = all.get(name);
        if (d) tools.push(d);
      }
    }
    // Omni savings (ADR-016 §11): what the native catalog would have cost
    deps.executor.recordList(forRequest(current(), requestInfo(h, false)), tools, descriptorTokens([...all.values()]));
    return { tools } as never;
  });

  server.setRequestHandler('tools/call', async (req, h) => {
    const ctx = forRequest(current(), requestInfo(h));
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const name = req.params.name;

    if (deps.outcomes && name === REPORT_OUTCOME && outcomeToolEnabled(ctx, 'omni')) return deps.outcomes(ctx, args) as never;
    const artifacts = deps.artifacts;
    if (artifacts?.enabled && isArtifactTool(name)) return deps.executor.artifactCall(ctx, name, () => callArtifactTool(artifacts, ctx, name, args)) as never;

    if (!META_NAMES.has(name)) {
      // Dynamic mode: native tool discovered by the search.
      if (!session.dynamic || !session.discovered.has(name)) {
        throw new McpProtocolError(-32602, text(msg('mcp.omniUnknownTool', { tool: name })));
      }
      return callInner(deps, ctx, name, args, locale);
    }

    if (name === 'search_tools') return deps.executor.metaCall(ctx, name, (rec) => searchTools(rec, ctx, args)) as never;
    if (name === 'get_tool_schema') return deps.executor.metaCall(ctx, name, (rec) => getToolSchema(rec, ctx, args)) as never;

    // call_tool
    if (typeof args.name !== 'string') return fail('VALIDATION_ERROR', msg('mcp.argRequired', { arg: 'name' }));
    return callInner(deps, ctx, args.name, (args.arguments ?? {}) as Record<string, unknown>, locale);
  });

  const searchTools = async (rec: CallRecorder, ctx: CallContext, args: Record<string, unknown>): Promise<ToolResult> => {
    const query = typeof args.query === 'string' ? args.query : '';
    const limit = Math.min(Math.max(Number(args.limit ?? 5) || 5, 1), 20);
    if (!query.trim()) return fail('VALIDATION_ERROR', msg('mcp.argRequired', { arg: 'query' }));
    const vis = visible();
    const allowed = deps.executor.catalog(ctx).filter((t) => t.state === 'enabled' && vis.has(t.name));
    const results = await deps.search.search(ctx.tenantId, query, allowed, limit);
    const items = results.map((r) => ({
      name: r.tool.name,
      title: r.tool.title ?? r.tool.name,
      description: short(describeTool(r.tool, locale)),
      ...(r.tool.annotations.destructiveHint ? { destructive: true } : {}),
      ...(r.tool.annotations.readOnlyHint ? { readOnly: true } : {}),
    }));
    if (session.dynamic && items.length) {
      const before = session.discovered.size;
      for (const i of items) session.discovered.add(i.name);
      if (session.discovered.size !== before) await server.sendToolListChanged().catch(() => undefined);
    }
    const listing = items.length
      ? items.map((i, n) => `${n + 1}. ${i.name} — ${i.title}: ${i.description}`).join('\n')
      : text(msg('mcp.searchNoResults'));
    // the query text is never recorded: only its hash and the names returned
    rec.meta({ queryHash: shortHash(query.trim().toLowerCase()), results: items.map((i) => i.name) });
    return ok({ results: items }, listing);
  };

  const getToolSchema = async (rec: CallRecorder, ctx: CallContext, args: Record<string, unknown>): Promise<ToolResult> => {
    const tool = deps.executor.catalog(ctx).find((t) => t.name === args.name);
    if (!tool || tool.state !== 'enabled' || !visible().has(tool.name)) {
      return fail('TOOL_NOT_FOUND', msg('mcp.omniToolNotFound', { tool: String(args.name) }));
    }
    const d = toDescriptor(tool, activeProjection(ctx.snapshot, tool.id), { locale });
    rec.meta({ tool: tool.name });
    return ok({
      name: d.name,
      title: d.title ?? d.name,
      description: d.description,
      inputSchema: d.inputSchema,
      ...(d.outputSchema ? { outputSchema: d.outputSchema } : {}),
      annotations: d.annotations ?? {},
    });
  };

  registerResources(server, [...(deps.artifacts ? [artifactResources(deps.artifacts)] : []), uiResources()], current);
  return server;
}

async function callInner(deps: OmniDeps, ctx: CallContext, name: string, args: Record<string, unknown>, locale: Locale): Promise<never> {
  try {
    return (await deps.executor.call(ctx, name, args)) as never;
  } catch (err) {
    // Inside Omni, an unknown/forbidden tool becomes a tool error (the agent can search again).
    if (err instanceof ProtocolError) {
      return errorResult({ error: err.error.code, message: translate(msg('mcp.useSearchTools', { error: err.error.msg }), locale) }) as never;
    }
    throw err;
  }
}

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ArtifactService } from '../proxy/artifacts';
import { ProtocolError, type CallContext, type ToolExecutor } from '../proxy/executor';
import { forRequest } from './call-context';
import { outcomeToolEnabled, REPORT_OUTCOME, reportOutcomeTool, type OutcomeHandler } from './outcomes';
import { artifactTools, callArtifactTool, isArtifactTool, registerArtifactResources } from './artifact-tools';
import pkg from '../../package.json' with { type: 'json' };

export const SERVER_INFO = { name: 'mcp-gateway', version: pkg.version };

/**
 * Creates a (stateless) MCP `Server` for one request, bound to the subject's context.
 * Gateway-authored texts (artifact tools, effect sentences, errors) use the principal's
 * locale; the virtual server instructions/description are tenant text and stay untouched.
 */
export function createMcpServer(executor: ToolExecutor, ctx: CallContext, artifacts?: ArtifactService, outcomes?: OutcomeHandler): Server {
  const vs = ctx.virtualServer;
  const locale = ctx.principal.locale;
  const server = new Server(
    { ...SERVER_INFO, ...(vs ? { name: `mcp-gateway/${vs.slug}`, title: vs.name ?? vs.slug } : {}) },
    {
      capabilities: { tools: { listChanged: true }, resources: {} },
      ...((vs?.instructions ?? vs?.description) ? { instructions: (vs.instructions ?? vs.description)! } : {}),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
    const withOutcome = outcomes && outcomeToolEnabled(ctx, 'native');
    const tools = [...executor.listTools(ctx), ...(artifacts?.enabled ? artifactTools(locale) : []), ...(withOutcome ? [reportOutcomeTool(locale)] : [])];
    executor.recordList(forRequest(ctx, req.params?._meta, extra.requestId), tools);
    return { tools } as never;
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const callCtx = forRequest(ctx, req.params._meta, extra.requestId, extra.signal);
    if (outcomes && req.params.name === REPORT_OUTCOME && outcomeToolEnabled(ctx, 'native')) return outcomes(callCtx, req.params.arguments ?? {}) as never;
    if (artifacts?.enabled && isArtifactTool(req.params.name)) {
      const { name, arguments: args = {} } = req.params;
      return executor.artifactCall(callCtx, name, () => callArtifactTool(artifacts, callCtx, name, args as Record<string, unknown>)) as never;
    }
    try {
      return await executor.call(callCtx, req.params.name, req.params.arguments ?? {});
    } catch (err) {
      if (err instanceof ProtocolError) {
        const e = err.error.toMcpError(locale);
        throw new McpError(e.code, e.message, e.data);
      }
      throw err;
    }
  });

  if (artifacts) registerArtifactResources(server, artifacts, () => ctx);

  return server;
}

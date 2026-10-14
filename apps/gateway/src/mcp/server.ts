import { ProtocolError as McpProtocolError, Server } from '@modelcontextprotocol/server';
import type { ArtifactService } from '../proxy/artifacts';
import { ProtocolError, type CallContext, type ToolExecutor } from '../proxy/executor';
import { forRequest, requestInfo } from './call-context';
import { outcomeToolEnabled, REPORT_OUTCOME, reportOutcomeTool, type OutcomeHandler } from './outcomes';
import { artifactResources, artifactTools, callArtifactTool, isArtifactTool } from './artifact-tools';
import { registerResources, uiResources } from './resources';
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

  server.setRequestHandler('tools/list', async (_req, h) => {
    // the request context carries the client's declared capabilities (ADR-021): MCP Apps hints depend on them
    const reqCtx = forRequest(ctx, requestInfo(h, false));
    const withOutcome = outcomes && outcomeToolEnabled(ctx, 'native');
    const tools = [...executor.listTools(reqCtx), ...(artifacts?.enabled ? artifactTools(locale) : []), ...(withOutcome ? [reportOutcomeTool(locale)] : [])];
    executor.recordList(reqCtx, tools);
    return { tools } as never;
  });

  server.setRequestHandler('tools/call', async (req, h) => {
    const callCtx = forRequest(ctx, requestInfo(h));
    if (outcomes && req.params.name === REPORT_OUTCOME && outcomeToolEnabled(ctx, 'native')) return outcomes(callCtx, req.params.arguments ?? {}) as never;
    if (artifacts?.enabled && isArtifactTool(req.params.name)) {
      const { name, arguments: args = {} } = req.params;
      return executor.artifactCall(callCtx, name, () => callArtifactTool(artifacts, callCtx, name, args as Record<string, unknown>)) as never;
    }
    try {
      return (await executor.call(callCtx, req.params.name, req.params.arguments ?? {})) as never;
    } catch (err) {
      if (err instanceof ProtocolError) {
        const e = err.error.toMcpError(locale);
        throw new McpProtocolError(e.code, e.message, e.data);
      }
      throw err;
    }
  });

  registerResources(server, [...(artifacts ? [artifactResources(artifacts)] : []), uiResources()], () => ctx);

  return server;
}

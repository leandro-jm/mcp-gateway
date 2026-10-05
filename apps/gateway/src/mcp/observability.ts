import { DIMENSIONS, FILTERS, METRICS, validateQuery, type LastRange } from '@mcp-gateway/call-analytics';
import { isGatewayError, readTrafficSettings } from '@mcp-gateway/core';
import type { Locale } from '@mcp-gateway/i18n';
import { msg, translate, type ServerMessageKey } from '@mcp-gateway/i18n/server';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { explainCall } from '../analytics/explain';
import { rangeOf, topFailingTools } from '../analytics/views';
import type { CallContext } from '../proxy/executor';
import { errorResult, type ToolResult } from '../proxy/result';
import type { Services } from '../services';
import { forRequest } from './call-context';
import { SERVER_INFO } from './server';

export const OBSERVABILITY_TOOL_NAMES = ['analytics_query', 'explain_call', 'top_failing_tools'] as const;

const RANGES = ['1h', '24h', '7d', '30d'];
const nullable = (type: string) => ({ type: [type, 'null'] });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Observability MCP tools (F15.14), in the caller's locale. Read-only, typed, never SQL or payloads. */
export function observabilityTools(locale: Locale) {
  const t = (key: ServerMessageKey) => translate(msg(key), locale);
  return [
    {
      name: 'analytics_query',
      title: t('mcp.obsAnalyticsQueryTitle'),
      description: t('mcp.obsAnalyticsQueryDescription'),
      inputSchema: {
        type: 'object',
        properties: {
          metric: { type: 'string', enum: [...METRICS] },
          groupBy: { type: 'array', items: { type: 'string', enum: [...DIMENSIONS] }, maxItems: 2 },
          filters: {
            type: 'object',
            properties: Object.fromEntries(FILTERS.map((f) => [f, { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }])),
            additionalProperties: false,
          },
          range: {
            anyOf: [
              { type: 'object', properties: { last: { type: 'string', enum: RANGES } }, required: ['last'], additionalProperties: false },
              { type: 'object', properties: { from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' } }, required: ['from', 'to'], additionalProperties: false },
            ],
          },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          order: { type: 'string', enum: ['asc', 'desc'] },
        },
        required: ['metric', 'range'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          metric: { type: 'string' },
          groupBy: { type: 'array', items: { type: 'string' } },
          from: { type: 'string' },
          to: { type: 'string' },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: { keys: { type: 'object', additionalProperties: nullable('string') }, value: nullable('number') },
              required: ['keys', 'value'],
            },
          },
        },
        required: ['metric', 'groupBy', 'from', 'to', 'rows'],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'explain_call',
      title: t('mcp.obsExplainCallTitle'),
      description: t('mcp.obsExplainCallDescription'),
      inputSchema: {
        type: 'object',
        properties: { call_id: { type: 'string', description: t('mcp.obsExplainCallIdDescription') } },
        required: ['call_id'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          call: { type: 'object' },
          stages: { type: 'array', items: { type: 'object' } },
          policy: { type: 'object' },
          data: { type: 'object' },
          tokens: { type: 'object' },
          children: { type: 'array', items: { type: 'object' } },
          audit: nullable('object'),
          traceUrl: nullable('string'),
        },
        required: ['call', 'stages', 'policy', 'data'],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'top_failing_tools',
      title: t('mcp.obsTopFailingTitle'),
      description: t('mcp.obsTopFailingDescription'),
      inputSchema: {
        type: 'object',
        properties: {
          last: { type: 'string', enum: RANGES, default: '7d' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
          group_by: { type: 'string', enum: ['source', 'agent'] },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          tools: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string' },
                calls: { type: 'number' },
                errors: { type: 'number' },
                errorRate: nullable('number'),
                previousErrorRate: nullable('number'),
                trend: { type: 'string', enum: ['up', 'down', 'flat', 'new'] },
                topErrorCode: nullable('string'),
                topErrorStage: nullable('string'),
                successRate: nullable('number'),
                by: { type: 'array', items: { type: 'object' } },
              },
              required: ['tool', 'calls', 'errors', 'trend'],
            },
          },
        },
        required: ['from', 'to', 'tools'],
      },
      annotations: { readOnlyHint: true },
    },
  ];
}

function ok(structured: object): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured as Record<string, unknown> };
}

/**
 * `/mcp/observability` (F15.14): the tenant's analytics as MCP tools, so an agent can investigate
 * ("why did tool X fail more this week?"). Stateless, one server per request.
 */
export function createObservabilityServer(services: Services, ctx: CallContext): Server {
  const locale = ctx.principal.locale;
  const fail = (error: string, key: ServerMessageKey, params?: Record<string, string | number>) =>
    errorResult({ error, message: translate(msg(key, params), locale) });
  const server = new Server(
    { ...SERVER_INFO, name: 'mcp-gateway/observability' },
    { capabilities: { tools: {} }, instructions: translate(msg('mcp.obsInstructions'), locale) },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
    const tools = observabilityTools(locale);
    services.executor.recordList(forRequest(ctx, req.params?._meta, extra.requestId), tools);
    return { tools } as never;
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const callCtx = forRequest(ctx, req.params._meta, extra.requestId, extra.signal);
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (!(OBSERVABILITY_TOOL_NAMES as readonly string[]).includes(name)) {
      throw new McpError(-32602, translate(msg('mcp.omniUnknownTool', { tool: name }), locale));
    }
    return services.executor.metaCall(
      callCtx,
      name,
      async () => {
        try {
          return await run();
        } catch (err) {
          // gateway errors (rate limit…) become tool errors the agent can read
          if (isGatewayError(err)) return err.toToolResult(locale) as ToolResult;
          throw err;
        }
      },
      'observability',
    ) as never;

    async function run(): Promise<ToolResult> {
      const rl = readTrafficSettings(ctx.snapshot.tenant.settings).rateLimits;
      await services.rateLimiter.check([
        { scope: 'client', key: `${ctx.tenantId}:observability:${ctx.principal.clientId ?? ctx.principal.sub}`, limit: rl.perClient },
      ]);
      if (name === 'analytics_query') {
        const v = validateQuery(args);
        if (!v.ok) return errorResult({ error: 'VALIDATION_ERROR', message: translate(v.error, locale) });
        return ok(await services.analytics.query(ctx.tenantId, v.query));
      }
      if (name === 'explain_call') {
        const callId = args.call_id;
        if (typeof callId !== 'string' || !UUID_RE.test(callId)) return fail('VALIDATION_ERROR', 'mcp.argRequired', { arg: 'call_id' });
        const explanation = await explainCall(services, ctx.tenantId, callId);
        if (!explanation) return fail('NOT_FOUND', 'mcp.obsCallNotFound', { callId });
        return ok(explanation);
      }
      const last = (RANGES.includes(String(args.last)) ? args.last : '7d') as LastRange;
      const groupBy = args.group_by === 'source' || args.group_by === 'agent' ? args.group_by : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : 10;
      return ok(await topFailingTools(services, ctx.tenantId, rangeOf(last), { limit, ...(groupBy ? { groupBy } : {}) }));
    }
  });

  return server;
}

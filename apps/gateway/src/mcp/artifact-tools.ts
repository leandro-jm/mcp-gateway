import { isGatewayError } from '@mcp-gateway/core';
import { formatDateTime, type Locale } from '@mcp-gateway/i18n';
import { msg, translate, type ServerMessageKey } from '@mcp-gateway/i18n/server';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, McpError, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ARTIFACT_SCHEME, type ArtifactService } from '../proxy/artifacts';
import type { CallContext } from '../proxy/executor';
import type { ToolResult } from '../proxy/result';

/** Artifact tool definitions, in the caller's locale. */
export function artifactTools(locale: Locale) {
  const t = (key: ServerMessageKey) => translate(msg(key), locale);
  return [
    {
      name: 'artifact_read',
      title: t('mcp.artifactReadTitle'),
      description: t('mcp.artifactReadDescription'),
      inputSchema: {
        type: 'object',
        properties: {
          uri: { type: 'string', description: 'artifact://…' },
          offset: { type: 'integer', minimum: 0, default: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
        },
        required: ['uri'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'artifact_query',
      title: t('mcp.artifactQueryTitle'),
      description: t('mcp.artifactQueryDescription'),
      inputSchema: {
        type: 'object',
        properties: { uri: { type: 'string' }, expression: { type: 'string', description: t('mcp.artifactQueryExpressionDescription') } },
        required: ['uri', 'expression'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
  ];
}

const NAMES = new Set<string>(['artifact_read', 'artifact_query']);

export function isArtifactTool(name: string): boolean {
  return NAMES.has(name);
}

const actx = (ctx: CallContext) => ({ tenantId: ctx.tenantId, sessionKey: ctx.sessionKey ?? 'anon', snapshot: ctx.snapshot, locale: ctx.principal.locale });

export async function callArtifactTool(artifacts: ArtifactService, ctx: CallContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    if (name === 'artifact_read') {
      const r = await artifacts.read(actx(ctx), String(args.uri ?? ''), Number(args.offset ?? 0), Number(args.limit ?? 50));
      return { content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r };
    }
    const result = await artifacts.query(actx(ctx), String(args.uri ?? ''), String(args.expression ?? ''));
    const structured = { result };
    return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
  } catch (err) {
    if (isGatewayError(err)) return err.toToolResult(ctx.principal.locale) as ToolResult;
    throw err;
  }
}

/** `resources/list` and `resources/read` on `artifact://…` (F8.3). */
export function registerArtifactResources(server: Server, artifacts: ArtifactService, getCtx: () => CallContext): void {
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const ctx = getCtx();
    const locale = ctx.principal.locale;
    return {
      resources: (await artifacts.list(actx(ctx))).map((a) => ({
        uri: a.uri,
        name: `${a.toolName ?? 'artifact'}-${a.id.slice(0, 8)}.json`,
        mimeType: a.contentType,
        size: a.sizeBytes,
        description: translate(
          msg('mcp.artifactResourceDescription', {
            tool: a.toolName ?? '',
            hasRows: a.rowCount !== null,
            rows: a.rowCount ?? 0,
            expiresAt: formatDateTime(locale, a.expiresAt),
          }),
          locale,
        ),
      })),
    };
  });
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const locale = getCtx().principal.locale;
    return {
      resourceTemplates: artifacts.enabled
        ? [
            {
              uriTemplate: `${ARTIFACT_SCHEME}{id}`,
              name: translate(msg('mcp.artifactTemplateName'), locale),
              mimeType: 'application/json',
              description: translate(msg('mcp.artifactTemplateDescription'), locale),
            },
          ]
        : [],
    };
  });
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const ctx = getCtx();
    try {
      const { artifact, data } = await artifacts.load(actx(ctx), req.params.uri);
      return { contents: [{ uri: artifact.uri, mimeType: artifact.contentType, text: JSON.stringify(data) }] };
    } catch (err) {
      if (isGatewayError(err)) throw new McpError(-32002, err.localize(ctx.principal.locale));
      throw err;
    }
  });
}

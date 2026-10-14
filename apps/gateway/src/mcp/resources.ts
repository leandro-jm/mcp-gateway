import { ResourceNotFoundError, type Server } from '@modelcontextprotocol/server';
import { MCP_APP_MIME_TYPE, type ViewResource } from '@mcp-ui-kit/view-spec';
import { viewHtml, viewManifest } from '@mcp-ui-kit/views';
import type { CallContext } from '../proxy/executor';
import { clientHasUi, tileHost, UI_RESOURCES } from '../proxy/ui';
import { forRequest, requestInfo } from './call-context';

export interface ResourceEntry {
  uri: string;
  name: string;
  title?: string;
  mimeType?: string;
  size?: number;
  description?: string;
}

export interface ResourceTemplateEntry {
  uriTemplate: string;
  name: string;
  mimeType?: string;
  description?: string;
}

export interface ReadResult {
  contents: Array<{ uri: string; mimeType?: string; text?: string; _meta?: Record<string, unknown> }>;
}

/** One family of resources (artifacts, UI…). `read` returns `undefined` for URIs it does not own. */
export interface ResourceProvider {
  list(ctx: CallContext): Promise<ResourceEntry[]>;
  templates(ctx: CallContext): ResourceTemplateEntry[];
  read(ctx: CallContext, uri: string): Promise<ReadResult | undefined>;
}

/**
 * Registers `resources/*` once per server over several providers: the SDK takes a single
 * handler per method, so artifacts (F8) and MCP Apps (ADR-022) share it.
 */
export function registerResources(server: Server, providers: ResourceProvider[], getCtx: () => CallContext): void {
  if (!providers.length) return;
  server.setRequestHandler('resources/list', async (_req, h) => {
    const ctx = forRequest(getCtx(), requestInfo(h, false));
    return { resources: (await Promise.all(providers.map((p) => p.list(ctx)))).flat() };
  });
  server.setRequestHandler('resources/templates/list', async (_req, h) => {
    const ctx = forRequest(getCtx(), requestInfo(h, false));
    return { resourceTemplates: providers.flatMap((p) => p.templates(ctx)) };
  });
  server.setRequestHandler('resources/read', async (req, h) => {
    const ctx = forRequest(getCtx(), requestInfo(h, false));
    for (const p of providers) {
      const r = await p.read(ctx, req.params.uri);
      if (r) return r as never;
    }
    throw new ResourceNotFoundError(req.params.uri);
  });
}

const URI_TO_NAME = new Map(Object.entries(UI_RESOURCES).map(([name, uri]) => [uri, name as ViewResource]));

/**
 * The generic MCP Apps of `@mcp-ui-kit/views` as `ui://mcp-gateway/*` (ADR-022). Hosts find them
 * through the tool descriptors, so the listing is only an extra for 2026-07-28 clients that
 * declared MCP Apps (2025-era listings stay exactly as before); reading is always allowed.
 */
export function uiResources(): ResourceProvider {
  return {
    async list(ctx) {
      if (ctx.client?.era !== 'modern' || !clientHasUi(ctx.client) || !ctx.snapshot.toolViews?.length) return [];
      return viewManifest().map((v) => ({ uri: UI_RESOURCES[v.name], name: `mcp-ui-kit ${v.name}`, mimeType: MCP_APP_MIME_TYPE, size: v.bytes }));
    },
    templates() {
      return [];
    },
    async read(ctx, uri) {
      const name = URI_TO_NAME.get(uri);
      if (!name) return undefined;
      const tiles = name === 'map' ? tileHost(ctx.snapshot) : undefined;
      return {
        contents: [
          {
            uri,
            mimeType: MCP_APP_MIME_TYPE,
            text: viewHtml(name),
            _meta: { ui: { csp: { resourceDomains: tiles ? [tiles] : [], connectDomains: [] }, prefersBorder: false } },
          },
        ],
      };
    },
  };
}

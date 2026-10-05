import {
  filterOperations,
  importDocument,
  mergeOpenApi,
  operationKeys,
  parseImportText,
  rebasePaths,
  type ImportResult,
  type OpenApiDocument,
} from '@mcp-gateway/api-import';
import { isGatewayError, ValidationError } from '@mcp-gateway/core';
import type { JsonObject, Source } from '@mcp-gateway/db';
import { isMessage } from '@mcp-gateway/i18n';
import { msg, translate, type ServerMessage } from '@mcp-gateway/i18n/server';
import { fetchSpec } from '@mcp-gateway/net';
import { canonicalJson, generateTools, parseSpec } from '@mcp-gateway/openapi-toolgen';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { z } from 'zod';
import { requestLocale } from '../../i18n';
import { resolveTenantId, ROLE } from '../auth';
import { crawlRunDto, sourceDto } from '../dto';
import { errorResponses, importBodySchema, importPreviewBodySchema, importPreviewSchema, importResultSchema, jsonObject, uuidParam } from '../schemas';
import { assertAllowedUrls, enqueueCrawl, tenantNetworkPolicy } from '../source-helpers';
import type { Services } from '../../services';

type ImportInput = z.output<typeof importBodySchema>['input'];

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** Import pipeline errors (`ImportError`, `SpecError`, `SpecFetchError`) carry a translatable message: they become 400. */
async function asValidation<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isGatewayError(err)) throw err;
    const m = (err as { msg?: unknown } | null)?.msg;
    if (isMessage(m)) throw new ValidationError(m as ServerMessage);
    throw err;
  }
}

function operationsByKey(doc: OpenApiDocument): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
  for (const [path, item] of Object.entries(paths)) {
    for (const m of METHODS) if (item?.[m]) out.set(`${m.toUpperCase()} ${path}`, item[m]);
  }
  return out;
}

function inlineSpec(source: Source): OpenApiDocument {
  if (!source.openapiInline) throw new ValidationError(msg('admin.sourceNotInline'), { sourceId: source.id });
  return source.openapiInline;
}

/** Requests generated from cURL/Postman/HAR target the base URL origin; warns when it differs. */
function originWarning(result: ImportResult, baseUrl: string): ServerMessage[] {
  const origin = result.format === 'openapi' ? undefined : result.baseUrlCandidates[0];
  if (!origin || new URL(origin).origin === new URL(baseUrl).origin) return [];
  return [msg('import.originMismatch', { origin, baseUrl })];
}

/** Source import from OpenAPI, cURL, Postman or HAR (ADR-014). */
export const sourceImportRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const { sources } = services.repos;
  const tags = ['sources'];
  const bodyLimit = services.config.IMPORT_MAX_BYTES;

  async function convert(tenantId: string, input: ImportInput): Promise<ImportResult> {
    if (input.kind === 'text') return asValidation(() => parseImportText(input.text, input.format));
    await assertAllowedUrls(services, tenantId, [input.url]);
    const credential = input.credentialId ? await services.repos.credentials.getDecrypted(tenantId, input.credentialId) : undefined;
    const network = await tenantNetworkPolicy(services, tenantId);
    return asValidation(async () => {
      const doc = await fetchSpec(input.url, {
        timeoutMs: services.config.IMPORT_FETCH_TIMEOUT_MS,
        maxBytes: services.config.IMPORT_MAX_BYTES,
        network,
        ...(credential ? { credential } : {}),
      });
      return importDocument(doc, input.format);
    });
  }

  app.post('/sources/import/preview', {
    bodyLimit,
    config: { roles: [ROLE.admin] },
    schema: {
      tags,
      summary: 'Converts the input and lists the tools it would generate, without saving anything',
      body: importPreviewBodySchema,
      response: { 200: importPreviewSchema, ...errorResponses },
    },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      req.affectedTenantId = undefined; // read-only: no registry invalidation
      const locale = requestLocale(req);
      const result = await convert(tenantId, req.body.input);
      const warnings = [...result.warnings];
      let incoming = req.body.include ? filterOperations(result.openapi, req.body.include) : result.openapi;
      let existing = new Map<string, unknown>();
      let sourceName = req.body.sourceName ?? result.suggestedName ?? 'api';
      if (req.body.targetSourceId) {
        const target = await sources.get(tenantId, req.body.targetSourceId);
        existing = operationsByKey(inlineSpec(target));
        sourceName = req.body.sourceName ?? target.name;
        if (result.format !== 'openapi') incoming = rebasePaths(incoming, target.baseUrl);
        warnings.push(...originWarning(result, target.baseUrl));
      }
      const spec = await asValidation(() => parseSpec(incoming));
      const generated = generateTools(spec, { sourceName });
      const toolByKey = new Map(generated.tools.map((t) => [t.operationKey, t]));
      const skippedByKey = new Map(generated.skipped.map((s) => [s.operationKey, s.reason]));
      const incomingOps = operationsByKey(incoming);
      return {
        format: result.format,
        specVersion: spec.specVersion,
        suggestedName: result.suggestedName ?? null,
        baseUrlCandidates: result.baseUrlCandidates,
        suggestedCredential: result.suggestedCredential ?? null,
        warnings: warnings.map((w) => ({ key: w.key, message: translate(w, locale) })),
        operations: spec.operations.map((op) => {
          const current = existing.get(op.key);
          const status = current === undefined ? 'new' : canonicalJson(current) === canonicalJson(incomingOps.get(op.key)) ? 'unchanged' : 'conflict';
          return {
            key: op.key,
            summary: op.summary ?? null,
            tags: op.tags,
            status,
            toolName: toolByKey.get(op.key)?.name ?? null,
            skipped: skippedByKey.get(op.key) ?? null,
          } as const;
        }),
        tools: generated.tools.map((t) => ({
          operationKey: t.operationKey,
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations as Record<string, unknown>,
        })),
      };
    },
  });

  app.post('/sources/import', {
    bodyLimit,
    config: { roles: [ROLE.admin] },
    schema: {
      tags,
      summary: 'Imports into a new or existing source and enqueues its crawl',
      body: importBodySchema,
      response: { 201: importResultSchema, ...errorResponses },
    },
    handler: async (req, reply) => {
      const tenantId = await resolveTenantId(services, req);
      const locale = requestLocale(req);
      const { input, include, target } = req.body;
      const result = await convert(tenantId, input);
      const warnings = [...result.warnings];
      const generatedFormat = result.format !== 'openapi';
      const meta = { format: result.format, input: input.kind, importedAt: new Date().toISOString() };
      let source: Source;
      let added: string[];
      let replaced: string[] = [];
      let conflicts: string[] = [];

      if (target.kind === 'new') {
        await assertAllowedUrls(services, tenantId, [target.baseUrl]);
        let doc = include ? filterOperations(result.openapi, include) : result.openapi;
        if (generatedFormat) doc = rebasePaths(doc, target.baseUrl);
        await asValidation(() => parseSpec(doc));
        added = operationKeys(doc);
        // OpenAPI and Postman URLs stay URLs (re-crawled, drift); everything else is stored converted
        const keepUrl = input.kind === 'url' && !include && (result.format === 'openapi' || result.format === 'postman');
        source = await sources.create(tenantId, {
          name: target.name,
          baseUrl: target.baseUrl,
          credentialId: target.credentialId ?? (keepUrl ? (input.credentialId ?? null) : null),
          crawlSchedule: target.crawlSchedule ?? null,
          ownerTeam: target.ownerTeam ?? null,
          ...(keepUrl ? { openapiUrl: input.url, specFormat: result.format === 'postman' ? 'postman' : 'openapi' } : { openapiInline: doc }),
          importMeta: { ...meta, operations: added.length },
        });
        warnings.push(...originWarning(result, target.baseUrl));
      } else {
        const current = await sources.get(tenantId, target.sourceId);
        // `include` holds the preview keys, taken before rebasing on the target base URL
        const selected = include ? filterOperations(result.openapi, include) : result.openapi;
        const incoming = generatedFormat ? rebasePaths(selected, current.baseUrl) : selected;
        const merged = mergeOpenApi(inlineSpec(current), incoming, target.mode);
        await asValidation(() => parseSpec(merged.doc));
        ({ added, replaced, conflicts } = merged);
        const previous = (current.importMeta ?? {}) as JsonObject;
        source = await sources.update(tenantId, current.id, {
          openapiInline: merged.doc,
          importMeta: { ...previous, ...meta, operations: operationKeys(merged.doc).length, merges: (Number(previous.merges) || 0) + 1 },
        });
        warnings.push(...originWarning(result, current.baseUrl), ...merged.warnings);
      }

      const run = await enqueueCrawl(services, tenantId, source.id);
      return reply.code(201).send({
        source: sourceDto(source),
        crawlRun: crawlRunDto(run, locale),
        added,
        replaced,
        conflicts,
        warnings: warnings.map((w) => ({ key: w.key, message: translate(w, locale) })),
      });
    },
  });

  app.get('/sources/:id/openapi', {
    config: { roles: [ROLE.admin, ROLE.owner] },
    schema: {
      tags,
      summary: 'Inline OpenAPI document of the source (to download, edit and send back with PATCH)',
      params: uuidParam,
      response: { 200: jsonObject, ...errorResponses },
    },
    handler: async (req) => inlineSpec(await sources.get(await resolveTenantId(services, req), req.params.id)),
  });
};

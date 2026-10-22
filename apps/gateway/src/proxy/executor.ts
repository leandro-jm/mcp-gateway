import {
  argsHash,
  canonicalJson,
  descriptorTokens,
  GATEWAY_ATTR,
  jsonBytes,
  LEGACY_ATTR,
  SEMCONV,
  shortHash,
  spanName,
  toSpanAttributes,
  type CallEndpoint,
  type EventToolKind,
  type PluginDecision,
  type SessionSource,
} from '@mcp-gateway/call-analytics';
import { CompositeError, executeComposite, parseComposite } from '@mcp-gateway/composition';
import {
  effectiveNetworkPolicy,
  Forbidden,
  isGatewayError,
  readCompositionSettings,
  readObservabilitySettings,
  readTrafficSettings,
  ToolDisabled,
  ToolNotFound,
  UpstreamError,
  ValidationError,
  type GatewayError,
  type TrafficSettings,
} from '@mcp-gateway/core';
import type { AuditRepo } from '@mcp-gateway/db';
import { DEFAULT_LOCALE, type Locale } from '@mcp-gateway/i18n';
import { msg, translate } from '@mcp-gateway/i18n/server';
import { bytesOf, FIELD_RE, project } from '@mcp-gateway/projection';
import { relaxOutputSchema } from '@mcp-gateway/redaction';
import { authorize } from '../auth/authorizer';
import type { Principal } from '../auth/tokens';
import type { Logger } from '../logger';
import { selectTools } from '../registry/catalog';
import type { RegistrySnapshot, SnapshotProjection, SnapshotSource, SnapshotTool, SnapshotVirtualServer } from '../registry/snapshot';
import { context, SpanKind, SpanStatusCode, trace, type Context, type Span, type Tracer } from '@opentelemetry/api';
import { recordCallMetrics, toAuditInput } from '../telemetry/call-events/derive';
import { CallRecorder } from '../telemetry/call-events/recorder';
import type { CallEventSink } from '../telemetry/call-events/sink';
import type { Metrics } from '../telemetry/metrics';
import { injectOutbound, inSpan } from '../telemetry/tracing';
import type { ArtifactService } from './artifacts';
import type { CaptureSlot, DebugCaptureService } from './debug-capture';
import { describeTool } from './effect';
import type { PiiService } from './pii';
import type { ArgValidator } from './validation';
import type { CircuitBreaker, RateLimiter } from './guards';
import { NetworkError, UpstreamTimeout } from './rest-adapter';
import { agentUpstreamMessage, errorResult, upstreamToToolResult, type ToolResult } from './result';
import { activeViews, clientHasUi, ConfirmTokens, descriptorUiMeta, fieldErrors, resultUiMeta } from './ui';
import type { ToolViews } from '@mcp-ui-kit/view-spec';
import type { UpstreamAdapter, UpstreamResult } from './types';

export interface CallContext {
  /** Trace context (parent span) of the call. */
  traceCtx?: Context;
  tenantId: string;
  /** Calling subject; its `locale` is the language of every text returned to the agent (ADR-012). */
  principal: Principal;
  /** Artifact session (ADR-010). */
  sessionKey?: string;
  /** Playground (F10.2): captures the raw upstream response (before redaction/projection). */
  capture?: {
    raw?: unknown;
    status?: number;
    redactions?: number;
    bytesSaved?: number;
    artifactId?: string;
    /** Raw step responses of a composite (debug capture, F15.17). */
    steps?: Array<{ stepId: string; tool: string; index?: number; status: number; body: unknown }>;
  };
  snapshot: RegistrySnapshot;
  virtualServer?: SnapshotVirtualServer;
  requestId?: string;
  signal?: AbortSignal;
  /** Trace context received from the agent (`_meta` or header), when accepted (ADR-016 §8). */
  inboundTrace?: { source: 'meta' | 'header'; parentSpanId: string };
  /** Who is calling and through where (ADR-016 §10); informative only, never used for authorization. */
  identity?: CallIdentity;
  /** What the MCP client declared for this request (ADR-021); informative only, never used for authorization. */
  client?: McpClientInfo;
  /**
   * UI hints of the request `_meta` (ADR-022): a view's confirmation token and self-declared
   * origin. `confirmed` is set by the server only, after consuming a valid token (never from `_meta`).
   */
  ui?: { confirmToken?: string; origin?: 'app'; confirmed?: boolean };
  /** What the agent says it is working on (`_meta` or header; ADR-025). Untrusted free text, never logged. */
  intent?: string;
}

/**
 * The MCP client as seen on one request (ADR-021). On the 2026-07-28 era every request carries
 * it in the `_meta` envelope; on 2025-era stateless requests only the protocol version header
 * is known (capabilities were sent on `initialize`, a different request).
 */
export interface McpClientInfo {
  era: 'modern' | 'legacy';
  protocolVersion?: string;
  name?: string;
  version?: string;
  /** Extension ids declared in `capabilities.extensions` (e.g. `io.modelcontextprotocol/ui`). */
  extensions: string[];
}

export interface CallIdentity {
  endpoint: CallEndpoint;
  sessionSource: SessionSource;
  /** Self-declared `clientInfo` of the MCP client. */
  agentName?: string;
  agentVersion?: string;
  protocolVersion?: string;
  jsonrpcId?: string;
}

export interface McpToolDescriptor {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface ExecutorDeps {
  adapter: UpstreamAdapter;
  validator: ArgValidator;
  rateLimiter: Pick<RateLimiter, 'check'>;
  circuit: CircuitBreaker;
  audit: Pick<AuditRepo, 'record'>;
  pii: PiiService;
  artifacts: Pick<ArtifactService, 'enabled' | 'shouldOffload' | 'offload' | 'resolveRefs'>;
  logger: Logger;
  metrics: Metrics;
  tracer: Tracer;
  /** Analytics sink for the wide call events (ADR-016). */
  sink: CallEventSink;
  /** Opt-in debug capture (F15.17); absent or disabled = nothing is captured. */
  debug?: DebugCaptureService;
  /** Environment allows private networks (dev/test). The tenant can only restrict it. */
  allowPrivateNetworks: boolean;
}

/** MCP protocol error (e.g. unknown tool); the transport returns it as a JSON-RPC error. */
export class ProtocolError extends Error {
  constructor(readonly error: GatewayError) {
    super(error.message);
  }
}

export const AGENT_FIELDS_ARG = '_fields';
export const OUTPUT_ARG = '_output';

export function activeProjection(snapshot: RegistrySnapshot, toolId: string): SnapshotProjection | undefined {
  return snapshot.projections.find((p) => p.toolId === toolId && p.status === 'active');
}

export interface DescriptorOptions {
  /** Artifacts are enabled: advertise `_output`. */
  artifacts?: boolean;
  /** Locale of the gateway-authored texts (effect sentence, `_fields`/`_output` descriptions). */
  locale?: Locale;
  /** Active views to advertise as an MCP App (ADR-022); only for clients with UI. */
  ui?: ToolViews;
}

/**
 * Advertised input schema: injects `_fields` when the tool projection allows it and `_output`
 * when artifacts are enabled (F8.2).
 */
export function advertisedInputSchema(t: SnapshotTool, projection?: SnapshotProjection, opts: DescriptorOptions = {}): Record<string, unknown> {
  if (!projection?.allowAgentFields && !opts.artifacts) return t.inputSchema;
  const props = { ...((t.inputSchema.properties ?? {}) as Record<string, unknown>) };
  if (projection?.allowAgentFields) {
    props[AGENT_FIELDS_ARG] = {
      type: 'array',
      items: { type: 'string', pattern: FIELD_RE.source },
      maxItems: 50,
      description: translate(msg('proxy.agentFieldsArgDescription'), opts.locale),
    };
  }
  if (opts.artifacts) {
    props[OUTPUT_ARG] = {
      type: 'string',
      enum: ['inline', 'artifact'],
      description: translate(msg('proxy.outputArgDescription'), opts.locale),
    };
  }
  return { ...t.inputSchema, properties: props };
}

export function toDescriptor(t: SnapshotTool, projection?: SnapshotProjection, opts: DescriptorOptions = {}): McpToolDescriptor {
  return {
    name: t.name,
    ...(t.title ? { title: t.title } : {}),
    description: describeTool(t, opts.locale ?? DEFAULT_LOCALE),
    inputSchema: advertisedInputSchema(t, projection, opts),
    // The advertised schema reflects the post-redaction/projection response (fields may disappear or become masks).
    ...(t.outputSchema ? { outputSchema: relaxOutputSchema(t.outputSchema) } : {}),
    annotations: { ...t.annotations, ...(t.title ? { title: t.title } : {}) },
    ...(opts.ui ? { _meta: descriptorUiMeta(opts.ui) } : {}),
  };
}

/** `_meta` key that returns the call id to the client (report_outcome, explain_call). */
export const CALL_ID_META = 'io.github.leandro-jm.mcp-gateway/call-id';

function withCallId(result: ToolResult, callId: string): ToolResult {
  const meta = (result._meta && typeof result._meta === 'object' ? result._meta : {}) as Record<string, unknown>;
  return { ...result, _meta: { ...meta, [CALL_ID_META]: callId } };
}

/** Bytes of the text content the model receives (the JSON text is already built: no extra stringify). */
function resultBytes(result: ToolResult): number {
  let n = 0;
  for (const c of result.content) if (typeof (c as { text?: unknown }).text === 'string') n += Buffer.byteLength((c as { text: string }).text);
  return n;
}

/** HTTP client span attributes: the path template, never the resolved URL (it may carry identifiers). */
function upstreamSpanAttributes(tool: SnapshotTool, source: SnapshotSource): Record<string, string> {
  const a: Record<string, string> = {};
  if (tool.operationRef) {
    a[SEMCONV.HTTP_REQUEST_METHOD] = tool.operationRef.method.toUpperCase();
    a[SEMCONV.URL_TEMPLATE] = tool.operationRef.path;
  }
  try {
    a[SEMCONV.SERVER_ADDRESS] = new URL(source.baseUrl).hostname;
  } catch {
    // invalid base URL: the call fails later with a proper error
  }
  return a;
}

/**
 * Data plane pipeline:
 * authz → limits → args validation → upstream (with credential) → PII → projection → offload.
 * Each call builds one wide event (ADR-016): audit, metrics, span attributes and analytics
 * derive from it in `finish`.
 */
export class ToolExecutor {
  private readonly defTokens = new WeakMap<SnapshotTool, number>();
  private readonly policyVersions = new WeakMap<RegistrySnapshot, string>();

  /** One-time confirmations of destructive calls made from a view (ADR-022). */
  private readonly confirmTokens: ConfirmTokens;

  constructor(private readonly deps: ExecutorDeps) {
    this.confirmTokens = new ConfirmTokens((tenantId) => deps.pii.analyticsKey(tenantId));
  }

  /** Visibility (list mode): args constraints are left for the call. */
  protected isAllowed(ctx: CallContext, tool: SnapshotTool): boolean {
    return authorize(ctx.snapshot, ctx.principal, tool, 'list').effect === 'allow';
  }

  catalog(ctx: CallContext): SnapshotTool[] {
    return selectTools(ctx.snapshot, ctx.virtualServer);
  }

  /** Enabled tools the subject can see (list mode), in catalog order. */
  visibleTools(ctx: CallContext): SnapshotTool[] {
    return this.catalog(ctx).filter((t) => t.state === 'enabled' && this.isAllowed(ctx, t));
  }

  listTools(ctx: CallContext, tools: SnapshotTool[] = this.visibleTools(ctx)): McpToolDescriptor[] {
    return tools.map((t) => {
      const ui = clientHasUi(ctx.client) ? activeViews(ctx.snapshot, t.id) : undefined;
      return toDescriptor(t, activeProjection(ctx.snapshot, t.id), { artifacts: this.deps.artifacts.enabled, locale: ctx.principal.locale, ...(ui ? { ui } : {}) });
    });
  }

  findTool(ctx: CallContext, name: string): SnapshotTool {
    const tool = this.catalog(ctx).find((t) => t.name === name);
    if (!tool) throw new ProtocolError(new ToolNotFound(name));
    return tool;
  }

  /** Tokens the tool descriptor costs in the model context (cached per snapshot tool). */
  private descriptorTokensOf(ctx: CallContext, tool: SnapshotTool): number {
    let n = this.defTokens.get(tool);
    if (n === undefined) {
      n = descriptorTokens(toDescriptor(tool, activeProjection(ctx.snapshot, tool.id), { artifacts: this.deps.artifacts.enabled }));
      this.defTokens.set(tool, n);
    }
    return n;
  }

  /** Short hash of the tenant policies: tells whether a past decision still holds (explain_call). */
  policyVersionOf(snapshot: RegistrySnapshot): string {
    let v = this.policyVersions.get(snapshot);
    if (!v) {
      v = shortHash(canonicalJson(snapshot.policies));
      this.policyVersions.set(snapshot, v);
    }
    return v;
  }

  /**
   * Ends a recorded call: span attributes, metrics, audit (awaited: compliance) and the
   * analytics event (buffered, never blocks).
   */
  private async finish(ctx: CallContext, rec: CallRecorder, span: Span | undefined, auditAction: string | undefined): Promise<void> {
    const ev = rec.finish();
    if (span) {
      span.setAttributes(toSpanAttributes(ev));
      if (ev.decision !== 'allow') span.setStatus({ code: SpanStatusCode.ERROR, message: ev.decision });
      span.end();
    }
    recordCallMetrics(this.deps.metrics, ev);
    if (auditAction) {
      await this.deps.audit
        .record(ctx.tenantId, toAuditInput(rec, auditAction))
        .catch((e: unknown) => this.deps.logger.warn({ err: e }, 'failed to record audit event'));
    }
    this.deps.sink.write(ev, rec.refs);
  }

  /** Root span of a call (SERVER), child of the agent span when the trace context came in. */
  private startRootSpan(callerCtx: CallContext, rec: CallRecorder): { span: Span; ctx: CallContext } {
    const parent = callerCtx.traceCtx ?? context.active();
    const slug = callerCtx.snapshot.tenant.slug;
    const span = this.deps.tracer.startSpan(
      spanName(rec.ev),
      {
        kind: SpanKind.SERVER,
        attributes: {
          [SEMCONV.MCP_METHOD_NAME]: 'tools/call',
          [SEMCONV.GEN_AI_OPERATION_NAME]: 'execute_tool',
          [SEMCONV.GEN_AI_TOOL_NAME]: rec.ev.toolName,
          [SEMCONV.GEN_AI_TOOL_CALL_ID]: rec.callId,
          [GATEWAY_ATTR.TENANT]: slug,
          [LEGACY_ATTR.TENANT]: slug,
          [LEGACY_ATTR.TOOL]: rec.ev.toolName,
        },
      },
      parent,
    );
    rec.setTrace(span.spanContext().traceId, span.spanContext().spanId);
    return { span, ctx: { ...callerCtx, traceCtx: trace.setSpan(parent, span) } };
  }

  async call(callerCtx: CallContext, name: string, rawArgs: unknown): Promise<ToolResult> {
    const rec = new CallRecorder(callerCtx, { kind: 'tool', toolName: name });
    const { span, ctx } = this.startRootSpan(callerCtx, rec);
    rec.policyVersion(this.policyVersionOf(ctx.snapshot));
    // debug capture (F15.17): raw upstream and steps are kept for an opt-in, time-limited capture
    const slot = this.deps.debug?.enabled ? await this.deps.debug.match(ctx, name) : undefined;
    if (slot) {
      // mutate (not replace): the playground reads its own capture object after the call
      ctx.capture ??= {};
      ctx.capture.steps ??= [];
    }
    let final: ToolResult | undefined;
    try {
      const tool = this.findTool(ctx, name);
      rec.setTool(tool, this.descriptorTokensOf(ctx, tool));
      const visible = authorize(ctx.snapshot, ctx.principal, tool, 'list');
      if (visible.effect !== 'allow') {
        // Not allowed: the tool does not exist for this subject.
        rec.policy(visible);
        throw new ProtocolError(new ToolNotFound(name));
      }
      // only after visibility: the state of a tool the subject cannot see is not revealed
      if (tool.state !== 'enabled') throw new ProtocolError(new ToolDisabled(name, tool.state));
      const result = await this.executeWithUi(ctx, tool, rawArgs ?? {}, rec);
      if (result.isError) rec.toolError(result);
      rec.responseBytes(resultBytes(result));
      if (ctx.capture) {
        Object.assign(ctx.capture, { redactions: rec.ev.redactionsCount ?? 0, bytesSaved: rec.projectedBytesSaved, artifactId: rec.ev.artifactId ?? undefined });
      }
      return (final = withCallId(result, rec.callId));
    } catch (err) {
      rec.fail(err instanceof ProtocolError ? err.error : err);
      if (err instanceof ProtocolError) throw err;
      if (isGatewayError(err)) {
        if (err.delivery === 'protocol') throw new ProtocolError(err);
        return (final = withCallId(err.toToolResult(ctx.principal.locale) as ToolResult, rec.callId));
      }
      this.deps.logger.error({ err, tool: name }, 'unexpected failure in tool call');
      return (final = withCallId(errorResult({ error: 'INTERNAL_ERROR', message: translate(msg('common.internalError'), ctx.principal.locale) }), rec.callId));
    } finally {
      await this.finish(ctx, rec, span, 'tools/call');
      if (slot) this.capture(ctx, slot, rec, name, rawArgs, final);
    }
  }

  /**
   * Generative UI around the pipeline (ADR-022), only for clients with UI and tools with active
   * views: destructive calls wait for a human confirmation (2026-07-28 clients), invalid
   * arguments come back as a prefilled form, results carry their view in `_meta` (never in
   * the model's content).
   */
  private async executeWithUi(ctx: CallContext, tool: SnapshotTool, rawArgs: unknown, rec: CallRecorder): Promise<ToolResult> {
    const views = clientHasUi(ctx.client) ? activeViews(ctx.snapshot, tool.id) : undefined;
    if (!views) return this.execute(ctx, tool, rawArgs, rec);
    const locale = ctx.principal.locale;
    const origin = ctx.ui?.origin ? { origin: ctx.ui.origin } : {};

    if (views.input?.kind === 'plan' && ctx.client?.era === 'modern') {
      const token = ctx.ui?.confirmToken;
      if (!token || !(await this.confirmTokens.consume(ctx, tool.name, token))) {
        rec.meta({ ui: { phase: 'input', view: 'plan', ...origin } });
        // no structuredContent: it would have to match the tool output schema
        return {
          content: [{ type: 'text', text: translate(msg('ui.confirmationRequired', { tool: tool.title ?? tool.name }), locale) }],
          _meta: resultUiMeta(ctx.snapshot, { views, phase: 'input', confirmToken: await this.confirmTokens.issue(ctx, tool.name) }),
        };
      }
    }

    try {
      const result = await this.execute(ctx, tool, rawArgs, rec);
      if (result.isError || !views.result) return result;
      rec.meta({ ui: { phase: 'result', view: views.result.kind, ...origin } });
      const payload = { views, phase: 'result' as const, ...(rec.ev.artifactId ? { truncated: true } : {}) };
      return { ...result, _meta: { ...(result._meta as Record<string, unknown> | undefined), ...resultUiMeta(ctx.snapshot, payload) } };
    } catch (err) {
      if (views.input?.kind !== 'form' || !(err instanceof ValidationError)) throw err;
      rec.fail(err);
      rec.meta({ ui: { phase: 'input', view: 'form', ...origin } });
      const base = err.toToolResult(locale) as ToolResult;
      return { ...base, _meta: resultUiMeta(ctx.snapshot, { views, phase: 'input', errors: fieldErrors(err.details, locale) }) };
    }
  }

  /** Hands the call to the debug capture, after the response (fire-and-forget). */
  private capture(ctx: CallContext, slot: CaptureSlot, rec: CallRecorder, tool: string, args: unknown, final: ToolResult | undefined): void {
    const p = ctx.principal;
    void this.deps.debug!.record(ctx.tenantId, slot, {
      callId: rec.callId,
      tool,
      capturedAt: new Date().toISOString(),
      principal: { sub: p.sub, roles: p.roles, groups: p.groups, ...(p.clientId ? { clientId: p.clientId } : {}), claims: p.claims },
      args,
      ...(ctx.capture?.status !== undefined && !ctx.capture.steps?.length ? { upstream: { status: ctx.capture.status, body: ctx.capture.raw } } : {}),
      ...(ctx.capture?.steps?.length ? { steps: ctx.capture.steps } : {}),
      final: final ?? null,
    });
  }

  /**
   * Artifact tools (F8) are not catalog tools, but they still count against the tenant and client
   * rate limits and are audited like any other call.
   */
  async artifactCall(ctx: CallContext, name: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
    const rec = new CallRecorder(ctx, { kind: 'artifact', toolName: name, toolKind: 'artifact' });
    try {
      const rl = readTrafficSettings(ctx.snapshot.tenant.settings).rateLimits;
      await this.deps.rateLimiter.check([
        { scope: 'tenant', key: `${ctx.tenantId}:tenant`, limit: rl.perTenant },
        { scope: 'client', key: `${ctx.tenantId}:client:${ctx.principal.clientId ?? ctx.principal.sub}`, limit: rl.perClient },
      ]);
      const result = await run();
      if (result.isError) rec.toolError(result);
      rec.responseBytes(resultBytes(result));
      return result;
    } catch (err) {
      rec.fail(err);
      if (isGatewayError(err)) return err.toToolResult(ctx.principal.locale) as ToolResult;
      throw err;
    } finally {
      await this.finish(ctx, rec, undefined, 'tools/call');
    }
  }

  /**
   * Gateway meta-tools (Omni discovery, observability MCP, report_outcome): recorded for analytics,
   * not audited (F15.7).
   */
  async metaCall(ctx: CallContext, name: string, run: (rec: CallRecorder) => Promise<ToolResult>, toolKind: EventToolKind = 'meta'): Promise<ToolResult> {
    const rec = new CallRecorder(ctx, { kind: 'meta', toolName: name, toolKind });
    try {
      const result = await run(rec);
      if (result.isError) rec.toolError(result);
      rec.responseBytes(resultBytes(result));
      return result;
    } catch (err) {
      rec.fail(err);
      throw err;
    } finally {
      await this.finish(ctx, rec, undefined, undefined);
    }
  }

  /** `tools/list` (analytics only): tokens the advertised catalog costs; Omni also reports the native one. */
  /**
   * `list` event of a `tools/list`. `fullCatalogTokens` is what the unreduced catalog would cost
   * (Omni, shortlist); `plugins` are the tool router decisions (ADR-025).
   */
  recordList(ctx: CallContext, tools: unknown[], opts: { fullCatalogTokens?: number; plugins?: PluginDecision[]; queryHash?: string } = {}): void {
    const rec = new CallRecorder(ctx, { kind: 'list', toolName: 'tools/list' });
    rec.catalogTokens(descriptorTokens(tools));
    rec.responseBytes(jsonBytes(tools));
    if (opts.fullCatalogTokens !== undefined || opts.queryHash) {
      rec.meta({ ...(opts.fullCatalogTokens !== undefined ? { fullCatalogTokens: opts.fullCatalogTokens } : {}), ...(opts.queryHash ? { queryHash: opts.queryHash } : {}) });
    }
    for (const d of opts.plugins ?? []) rec.plugin(d);
    void this.finish(ctx, rec, undefined, undefined);
  }

  protected async execute(ctx: CallContext, tool: SnapshotTool, rawArgs: unknown, rec: CallRecorder): Promise<ToolResult> {
    if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) {
      throw new ValidationError(msg('proxy.argsNotObject'));
    }
    const traffic = readTrafficSettings(ctx.snapshot.tenant.settings);

    const size = Buffer.byteLength(JSON.stringify(rawArgs));
    rec.requestBytes(size);
    if (size > traffic.limits.maxRequestBytes) {
      throw new ValidationError(msg('proxy.argsTooLarge', { limit: traffic.limits.maxRequestBytes }), { size });
    }

    const rl = traffic.rateLimits;
    await this.deps.rateLimiter.check([
      { scope: 'tenant', key: `${ctx.tenantId}:tenant`, limit: rl.perTenant },
      { scope: 'client', key: `${ctx.tenantId}:client:${ctx.principal.clientId ?? ctx.principal.sub}`, limit: rl.perClient },
      { scope: `tool ${tool.name}`, key: `${ctx.tenantId}:tool:${tool.id}`, limit: rl.tools[tool.name] ?? rl.perTool },
    ]);

    // `_fields` belongs to the gateway (projection requested by the agent) and never reaches the upstream.
    const projection = activeProjection(ctx.snapshot, tool.id);
    const { [AGENT_FIELDS_ARG]: agentFields, [OUTPUT_ARG]: outputMode, ...withRefs } = rawArgs as Record<string, unknown>;
    // loop detection (F15.19) compares what the agent sent, without storing it
    rec.argsHash(argsHash(await this.deps.pii.analyticsKey(ctx.tenantId), withRefs));
    if (outputMode !== undefined && outputMode !== 'inline' && outputMode !== 'artifact') {
      throw new ValidationError(msg('proxy.invalidOutputMode', { arg: OUTPUT_ARG }));
    }
    if (outputMode === 'artifact' && !this.deps.artifacts.enabled) throw new ValidationError(msg('proxy.artifactsDisabled'));
    const artifactCtx = { tenantId: ctx.tenantId, sessionKey: ctx.sessionKey ?? 'anon', snapshot: ctx.snapshot, locale: ctx.principal.locale };
    // F8.4: `{ "$artifact": "artifact://…", "path": "…" }` becomes the selected value.
    const { args: callArgs } = this.deps.artifacts.enabled ? await this.deps.artifacts.resolveRefs(artifactCtx, withRefs) : { args: withRefs };
    if (agentFields !== undefined) {
      if (!projection?.allowAgentFields) throw new ValidationError(msg('proxy.agentFieldsNotAccepted', { arg: AGENT_FIELDS_ARG }));
      if (!Array.isArray(agentFields) || agentFields.length > 50 || !agentFields.every((f) => typeof f === 'string' && FIELD_RE.test(f))) {
        throw new ValidationError(msg('proxy.agentFieldsInvalid', { arg: AGENT_FIELDS_ARG }));
      }
    }

    // PII tokens (pii_tok_*) are turned back into the real value only here, inside the gateway.
    const { args, count } = await rec.stage('pii', () => this.deps.pii.detokenize({ ...ctx, subject: ctx.principal.sub }, tool, callArgs));
    rec.detokenized(count);
    // LGPD subject index (ADR-017): whose identifiers the agent sent
    const fingerprints = await this.deps.pii.fingerprintOptions(ctx);
    if (fingerprints) {
      const scanned = await rec.stage('pii', () => this.deps.pii.scanRequest({ ...ctx, subject: ctx.principal.sub }, args));
      rec.subjectRefs(scanned.fingerprints.map((f) => ({ ...f, direction: 'request' as const })), scanned.truncated);
    }
    await rec.stage('validation', () => this.validate(tool, args));
    await rec.stage('authz', () =>
      inSpan(this.deps.tracer, 'authz', ctx.traceCtx, { [LEGACY_ATTR.TOOL]: tool.name }, () => this.authorizeCall(ctx, tool, args, rec)),
    );

    const res = await rec.stage('upstream', () =>
      tool.kind === 'composite' ? this.runComposite(ctx, tool, args, rec) : this.invokeUpstream(ctx, tool, args, traffic),
    );
    rec.upstream(res);
    if (ctx.capture) {
      ctx.capture.raw = res.body;
      ctx.capture.status = res.status;
    }

    // PII leaves the gateway masked: redaction before building the result (error messages included).
    const redacted = await rec.stage('pii', () =>
      inSpan(this.deps.tracer, 'redaction', ctx.traceCtx, {}, async (sp) => {
        const r = await this.deps.pii.redactResponse(
          { tenantId: ctx.tenantId, snapshot: ctx.snapshot, locale: ctx.principal.locale, subject: ctx.principal.sub },
          tool,
          res.body,
          fingerprints,
        );
        sp.setAttribute('mcp.redactions', r.count);
        return r;
      }),
    );
    rec.redactions(redacted.count, redacted.byDetector);
    if (redacted.fingerprints) {
      rec.subjectRefs(redacted.fingerprints.map((f) => ({ ...f, direction: 'response' as const })), redacted.fingerprintsTruncated ?? false);
    }

    // Projection (F6): the tool policy and, if allowed, the fields requested by the agent.
    let finalStructured: unknown;
    let structuredReady = false;
    const transform = (structured: unknown): unknown => {
      let value = structured;
      if (projection || agentFields) {
        const t0 = performance.now();
        const sp = this.deps.tracer.startSpan('projection', {}, ctx.traceCtx);
        const p = project(
          structured,
          projection
            ? { include: projection.include, exclude: projection.exclude, maxArrayItems: projection.maxArrayItems, maxBytes: projection.maxBytes }
            : {},
          { ...(agentFields ? { fields: agentFields as string[] } : {}), locale: ctx.principal.locale },
        );
        rec.projection(p.bytesBefore, p.bytesAfter, projection?.id, agentFields !== undefined);
        sp.setAttributes({ 'mcp.bytes_before': p.bytesBefore, 'mcp.bytes_after': p.bytesAfter, [GATEWAY_ATTR.BYTES_BEFORE]: p.bytesBefore, [GATEWAY_ATTR.BYTES_AFTER]: p.bytesAfter });
        sp.end();
        rec.addStage('projection', performance.now() - t0);
        value = p.value;
      }
      finalStructured = value;
      structuredReady = true;
      return value;
    };
    const result = upstreamToToolResult(tool, { ...res, body: redacted.value }, { locale: ctx.principal.locale, transform });

    // Offload (F8.2): a large response (or one requested by the agent) becomes an artifact; the agent gets a summary.
    if (structuredReady && this.deps.artifacts.shouldOffload(artifactCtx, bytesOf(finalStructured), outputMode === 'artifact')) {
      const { result: summary, artifact } = await rec.stage('artifact', () =>
        inSpan(this.deps.tracer, 'artifact.offload', ctx.traceCtx, {}, async (sp) => {
          const r = await this.deps.artifacts.offload(artifactCtx, tool.name, rec.callId, finalStructured);
          sp.setAttributes({ 'mcp.artifact_bytes': r.artifact.sizeBytes, [GATEWAY_ATTR.ARTIFACT_BYTES]: r.artifact.sizeBytes });
          return r;
        }),
      );
      rec.artifact(artifact.id, artifact.sizeBytes, resultBytes(summary));
      return summary;
    }
    return result;
  }

  /** Validates arguments against the tool input schema. */
  validate(tool: SnapshotTool, args: Record<string, unknown>): void {
    this.deps.validator.validate(`${tool.id}:${tool.version}:${JSON.stringify(tool.inputSchema).length}`, tool.inputSchema, args);
  }

  /**
   * Re-evaluates the policy with the arguments (never trusts the list alone) and applies obligations.
   * The decision (allow included) goes to the call's recorder.
   */
  async authorizeCall(ctx: CallContext, tool: SnapshotTool, args: Record<string, unknown>, rec?: CallRecorder, step?: string): Promise<void> {
    const decision = authorize(ctx.snapshot, ctx.principal, tool, 'call', args);
    rec?.policy(decision, step);
    if (decision.effect !== 'allow') {
      const denied = step
        ? msg('proxy.accessDeniedStep', { step, tool: tool.name, explanation: decision.explanation })
        : msg('proxy.accessDenied', { explanation: decision.explanation });
      throw new Forbidden(denied, { reason: decision.reason, ...(step ? { step, tool: tool.name } : {}) });
    }
    if (decision.obligations.rateLimits.length) {
      await this.deps.rateLimiter.check(
        decision.obligations.rateLimits.map((o) => ({
          scope: `policy ${o.ruleId}`,
          key: `${ctx.tenantId}:policy:${o.ruleId}:${ctx.principal.sub}`,
          limit: { limit: o.limit, windowSec: o.windowSec },
        })),
      );
    }
  }

  /** Calls the upstream (credential, circuit breaker, response limits). */
  async invokeUpstream(
    ctx: CallContext,
    tool: SnapshotTool,
    args: Record<string, unknown>,
    traffic: TrafficSettings,
  ): Promise<UpstreamResult> {
    const source = ctx.snapshot.sources.find((s) => s.id === tool.sourceId);
    if (!source) throw new UpstreamError(msg('proxy.sourceNotFound', { tool: tool.name }));
    if (source.status !== 'active') throw new UpstreamError(msg('proxy.sourceInactive', { source: source.name, status: source.status }));

    const circuitKey = `${ctx.tenantId}:${source.id}`;
    this.deps.circuit.before(circuitKey, source.name, traffic.circuitBreaker);
    const labels = { tenant: ctx.snapshot.tenant.slug, source: source.name };
    const span = this.deps.tracer.startSpan(
      'upstream',
      { kind: SpanKind.CLIENT, attributes: { ...upstreamSpanAttributes(tool, source), [GATEWAY_ATTR.SOURCE]: source.name, 'mcp.source': source.name, [LEGACY_ATTR.TOOL]: tool.name } },
      ctx.traceCtx,
    );
    const t0 = Date.now();
    const outbound = readObservabilitySettings(ctx.snapshot.tenant.settings).tracePropagation.outbound;
    let res: UpstreamResult;
    try {
      res = await this.deps.adapter.call({
        tenantId: ctx.tenantId,
        tool,
        source,
        args,
        maxResponseBytes: traffic.limits.maxResponseBytes,
        network: effectiveNetworkPolicy(this.deps.allowPrivateNetworks, ctx.snapshot.tenant.settings),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(outbound ? { traceHeaders: injectOutbound(trace.setSpan(ctx.traceCtx ?? context.active(), span)) } : {}),
      });
    } catch (err) {
      // Only source failures count (network, timeout); the gateway's own limits do not.
      if (err instanceof NetworkError || err instanceof UpstreamTimeout) {
        this.deps.circuit.failure(circuitKey, traffic.circuitBreaker);
        this.deps.metrics.circuitOpen.set(labels, this.deps.circuit.isOpen(circuitKey) ? 1 : 0);
      }
      this.deps.metrics.upstreamRequests.inc({ ...labels, status_class: 'error' });
      span.recordException(err as Error);
      span.setStatus({ code: 2, message: (err as Error).message });
      span.end();
      throw err;
    } finally {
      this.deps.metrics.upstreamDuration.observe(labels, (Date.now() - t0) / 1000);
    }
    this.deps.metrics.upstreamRequests.inc({ ...labels, status_class: `${Math.floor(res.status / 100)}xx` });
    span.setAttributes({
      [SEMCONV.HTTP_RESPONSE_STATUS_CODE]: res.status,
      [SEMCONV.HTTP_REQUEST_RESEND_COUNT]: Math.max(0, res.attempts - 1),
      'mcp.attempts': res.attempts,
    });
    if (res.status >= 500) span.setStatus({ code: 2 });
    span.end();
    if (res.status >= 500) this.deps.circuit.failure(circuitKey, traffic.circuitBreaker);
    else this.deps.circuit.success(circuitKey);
    this.deps.metrics.circuitOpen.set(labels, this.deps.circuit.isOpen(circuitKey) ? 1 : 0);
    return res;
  }

  /**
   * Composite tool (F7b.3/F7b.4): runs the DAG calling the base tools with the caller's
   * identity (authz per step). Raw data stays in memory; redaction, projection and offload
   * happen once, on the final output. Each step is its own event, linked by `parent_call_id`.
   */
  protected async runComposite(ctx: CallContext, tool: SnapshotTool, input: Record<string, unknown>, rec: CallRecorder): Promise<UpstreamResult> {
    const comp = ctx.snapshot.composites.find((c) => c.toolId === tool.id);
    if (!comp || comp.status !== 'valid') throw new UpstreamError(msg('proxy.compositeInvalid', { tool: tool.name }));
    const def = parseComposite({ name: tool.baseName, description: tool.description, ...comp.definition });
    const limits = readCompositionSettings(ctx.snapshot.tenant.settings);
    const traffic = readTrafficSettings(ctx.snapshot.tenant.settings);
    const byName = new Map(ctx.snapshot.tools.map((t) => [t.name, t]));

    // Pre-check: without permission to see every step tool, it does not even start.
    for (const step of def.steps) {
      const st = byName.get(step.tool);
      if (!st || st.state !== 'enabled') throw new UpstreamError(msg('proxy.stepToolUnavailable', { step: step.id, tool: step.tool }));
      const d = authorize(ctx.snapshot, ctx.principal, st, 'list');
      if (d.effect !== 'allow') {
        rec.deny(d.reason, { step: step.id, tool: step.tool });
        throw new Forbidden(msg('proxy.accessDeniedStep', { step: step.id, tool: step.tool, explanation: d.explanation }), {
          reason: d.reason,
          step: step.id,
          tool: step.tool,
        });
      }
    }
    if (def.steps.length > limits.maxSteps) throw new ValidationError(msg('proxy.compositeTooManySteps', { max: limits.maxSteps }));

    const started = Date.now();
    try {
      const result = await executeComposite(def, input, {
        limits: { maxCalls: limits.maxCalls, maxIntermediateBytes: limits.maxIntermediateBytes },
        locale: ctx.principal.locale,
        callStep: async (call) => {
          const st = byName.get(call.tool)!;
          const stepRec = new CallRecorder(ctx, { kind: 'composite_step', toolName: st.name, parentCallId: rec.callId });
          stepRec.setTool(st);
          stepRec.auditDetails = { step: call.stepId, ...(call.index !== undefined ? { index: call.index } : {}) };
          const stepSpan = this.deps.tracer.startSpan(
            'composite.step',
            { attributes: { [GATEWAY_ATTR.STEP]: call.stepId, 'mcp.step': call.stepId, [LEGACY_ATTR.TOOL]: call.tool } },
            ctx.traceCtx,
          );
          stepRec.setTrace(stepSpan.spanContext().traceId, stepSpan.spanContext().spanId);
          const stepCtx = { ...ctx, traceCtx: trace.setSpan(ctx.traceCtx ?? context.active(), stepSpan), signal: call.signal };
          try {
            await stepRec.stage('validation', () => this.validate(st, call.args));
            await stepRec.stage('authz', () => this.authorizeCall(stepCtx, st, call.args, stepRec, call.stepId));
            // a composite fans out: each step counts against its tool's limit, as a direct call would
            const rl = traffic.rateLimits;
            await this.deps.rateLimiter.check([{ scope: `tool ${st.name}`, key: `${ctx.tenantId}:tool:${st.id}`, limit: rl.tools[st.name] ?? rl.perTool }]);
            const res = await stepRec.stage('upstream', () => this.invokeUpstream(stepCtx, st, call.args, traffic));
            stepRec.upstream(res);
            ctx.capture?.steps?.push({ stepId: call.stepId, tool: st.name, ...(call.index !== undefined ? { index: call.index } : {}), status: res.status, body: res.body });
            if (res.status >= 400) {
              // the message reaches the agent: redacted like the error body of a simple call
              const body = res.status < 500 ? (await this.deps.pii.redactResponse({ tenantId: ctx.tenantId, snapshot: ctx.snapshot, locale: ctx.principal.locale, subject: ctx.principal.sub }, st, res.body)).value : undefined;
              const message = agentUpstreamMessage(res.status, body) ?? `HTTP ${res.status}`;
              throw Object.assign(new UpstreamError(msg('proxy.stepUpstreamFailed', { tool: call.tool, status: res.status, message }), res.status), {
                code: 'UPSTREAM_ERROR',
              });
            }
            return res.body;
          } catch (err) {
            stepRec.fail(err);
            throw err;
          } finally {
            await this.finish(ctx, stepRec, stepSpan, 'composite.step');
          }
        },
      });
      rec.auditDetails = { ...(rec.auditDetails ?? {}), calls: result.calls, failedSteps: Object.keys(result.errors) };
      return { status: 200, contentType: 'application/json', body: result.output, bytes: 0, durationMs: Date.now() - started, attempts: 1 };
    } catch (err) {
      if (err instanceof CompositeError) {
        const cause = err.cause;
        if (cause instanceof Forbidden) throw cause;
        throw new UpstreamError(err.msg, undefined, { step: err.stepId, code: err.code });
      }
      throw err;
    }
  }
}

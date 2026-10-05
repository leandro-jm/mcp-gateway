import { overheadMs, type CallEvent } from './event';

/**
 * OpenTelemetry attribute names (ADR-016 §9). The GenAI and MCP semantic conventions are still
 * incubating: every name lives here so a rename is a one-line change.
 */
export const SEMCONV = {
  // GenAI
  GEN_AI_OPERATION_NAME: 'gen_ai.operation.name',
  GEN_AI_TOOL_NAME: 'gen_ai.tool.name',
  GEN_AI_TOOL_CALL_ID: 'gen_ai.tool.call.id',
  GEN_AI_TOOL_TYPE: 'gen_ai.tool.type',
  // MCP
  MCP_METHOD_NAME: 'mcp.method.name',
  MCP_SESSION_ID: 'mcp.session.id',
  MCP_PROTOCOL_VERSION: 'mcp.protocol.version',
  JSONRPC_REQUEST_ID: 'jsonrpc.request.id',
  // general
  ERROR_TYPE: 'error.type',
  HTTP_REQUEST_METHOD: 'http.request.method',
  HTTP_RESPONSE_STATUS_CODE: 'http.response.status_code',
  HTTP_REQUEST_RESEND_COUNT: 'http.request.resend_count',
  URL_TEMPLATE: 'url.template',
  SERVER_ADDRESS: 'server.address',
} as const;

/** Gateway-specific attributes (the `mcp.*` namespace belongs to the OTel conventions). */
export const GATEWAY_ATTR = {
  TENANT: 'mcp_gateway.tenant',
  ENDPOINT: 'mcp_gateway.endpoint',
  TOOL_KIND: 'mcp_gateway.tool.kind',
  SOURCE: 'mcp_gateway.source',
  DECISION: 'mcp_gateway.decision',
  ERROR_STAGE: 'mcp_gateway.error.stage',
  POLICY_RULE_ID: 'mcp_gateway.policy.rule_id',
  AGENT_NAME: 'mcp_gateway.agent.name',
  REDACTIONS: 'mcp_gateway.redactions',
  BYTES_BEFORE: 'mcp_gateway.projection.bytes_before',
  BYTES_AFTER: 'mcp_gateway.projection.bytes_after',
  ARTIFACT_BYTES: 'mcp_gateway.artifact.bytes',
  RESPONSE_TOKENS: 'mcp_gateway.tokens.response',
  TOKENS_SAVED: 'mcp_gateway.tokens.saved',
  OVERHEAD_MS: 'mcp_gateway.overhead_ms',
  STEP: 'mcp_gateway.step',
} as const;

/** Pre-F15 attribute names, still emitted for one phase (deprecated). */
export const LEGACY_ATTR = {
  TENANT: 'mcp.tenant',
  TOOL: 'mcp.tool',
  DECISION: 'mcp.decision',
} as const;

export type SpanAttributes = Record<string, string | number | boolean>;

const METHOD_BY_KIND: Record<CallEvent['kind'], string> = {
  tool: 'tools/call',
  composite_step: 'tools/call',
  meta: 'tools/call',
  artifact: 'tools/call',
  list: 'tools/list',
  outcome: 'tools/call',
};

/** Root span name: `{mcp.method.name} {target}`, as the MCP conventions suggest. */
export function spanName(ev: Pick<CallEvent, 'kind' | 'toolName'>): string {
  const method = METHOD_BY_KIND[ev.kind];
  return ev.kind === 'list' ? method : `${method} ${ev.toolName}`;
}

/** Root span attributes derived from the event (set when the call ends). */
export function toSpanAttributes(ev: CallEvent): SpanAttributes {
  const a: SpanAttributes = {
    [SEMCONV.MCP_METHOD_NAME]: METHOD_BY_KIND[ev.kind],
    [SEMCONV.GEN_AI_OPERATION_NAME]: 'execute_tool',
    [SEMCONV.GEN_AI_TOOL_NAME]: ev.toolName,
    [SEMCONV.GEN_AI_TOOL_CALL_ID]: ev.callId,
    [GATEWAY_ATTR.ENDPOINT]: ev.endpoint,
    [GATEWAY_ATTR.DECISION]: ev.decision,
    [GATEWAY_ATTR.OVERHEAD_MS]: overheadMs(ev),
    [LEGACY_ATTR.TOOL]: ev.toolName,
    [LEGACY_ATTR.DECISION]: ev.decision,
  };
  if (ev.tenantSlug) {
    a[GATEWAY_ATTR.TENANT] = ev.tenantSlug;
    a[LEGACY_ATTR.TENANT] = ev.tenantSlug;
  }
  if (ev.toolKind) {
    a[GATEWAY_ATTR.TOOL_KIND] = ev.toolKind;
    a[SEMCONV.GEN_AI_TOOL_TYPE] = ev.toolKind === 'meta' ? 'extension' : 'function';
  }
  if (ev.sessionKey) a[SEMCONV.MCP_SESSION_ID] = ev.sessionKey;
  if (ev.protocolVersion) a[SEMCONV.MCP_PROTOCOL_VERSION] = ev.protocolVersion;
  if (ev.jsonrpcId) a[SEMCONV.JSONRPC_REQUEST_ID] = ev.jsonrpcId;
  if (ev.errorCode) a[SEMCONV.ERROR_TYPE] = ev.errorCode;
  if (ev.errorStage) a[GATEWAY_ATTR.ERROR_STAGE] = ev.errorStage;
  if (ev.upstreamStatus) a[SEMCONV.HTTP_RESPONSE_STATUS_CODE] = ev.upstreamStatus;
  if (ev.policyRuleId) a[GATEWAY_ATTR.POLICY_RULE_ID] = ev.policyRuleId;
  if (ev.agentName) a[GATEWAY_ATTR.AGENT_NAME] = ev.agentName;
  if (ev.redactionsCount) a[GATEWAY_ATTR.REDACTIONS] = ev.redactionsCount;
  if (ev.responseTokens != null) a[GATEWAY_ATTR.RESPONSE_TOKENS] = ev.responseTokens;
  const saved = (ev.tokensSavedProjection ?? 0) + (ev.tokensSavedArtifact ?? 0);
  if (saved) a[GATEWAY_ATTR.TOKENS_SAVED] = saved;
  return a;
}

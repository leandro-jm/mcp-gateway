import type { OperationRef, ToolAnnotations } from '@mcp-gateway/core';
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  date,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });

// ---------------------------------------------------------------- enums
export const tenantStatus = pgEnum('tenant_status', ['active', 'suspended']);
export const sourceStatus = pgEnum('source_status', ['active', 'paused', 'error']);
/** Format behind `openapi_url` (ADR-014): Postman collections are converted to OpenAPI on every crawl. */
export const sourceSpecFormat = pgEnum('source_spec_format', ['openapi', 'postman']);
export const credentialType = pgEnum('credential_type', [
  'oauth2_client_credentials',
  'oauth2_password',
  'api_key',
  'bearer_static',
  'basic',
]);
export const toolKind = pgEnum('tool_kind', ['openapi', 'manual', 'composite']);
export const toolState = pgEnum('tool_state', ['disabled', 'enabled', 'deprecated', 'removed']);
export const subjectType = pgEnum('subject_type', ['role', 'client', 'user', 'group']);
export const policyEffect = pgEnum('policy_effect', ['allow', 'deny']);
export const failureMode = pgEnum('failure_mode', ['abort', 'partial']);
export const compositeStatus = pgEnum('composite_status', ['draft', 'valid', 'invalid']);
export const piiScope = pgEnum('pii_scope', ['global', 'source', 'tool']);
export const piiStrategy = pgEnum('pii_strategy', ['mask', 'hash', 'drop', 'tokenize']);
export const piiDirection = pgEnum('pii_direction', ['request', 'response', 'both']);
export const crawlStatus = pgEnum('crawl_status', ['queued', 'running', 'succeeded', 'failed']);
export const driftKind = pgEnum('drift_kind', ['added', 'changed', 'removed', 'breaking']);
export const userKind = pgEnum('user_kind', ['human', 'service']);
export const userStatus = pgEnum('user_status', ['active', 'disabled']);
export const apiTokenKind = pgEnum('api_token_kind', ['session', 'api']);
/** Same values as `LOCALES` in `@mcp-gateway/i18n` (ADR-012). */
export const userLocale = pgEnum('user_locale', ['en', 'pt-BR', 'es']);
/** LLM provider used by the natural-language composer (ADR-015). */
export const llmProvider = pgEnum('llm_provider', ['anthropic', 'openai', 'openai_compatible']);
/** How an OpenAI-compatible provider is asked for JSON: strict `json_schema` or plain `json_object`. */
export const llmJsonMode = pgEnum('llm_json_mode', ['schema', 'object']);

// ---------------------------------------------------------------- types
export type { OperationRef, ToolAnnotations };

export type JsonObject = Record<string, unknown>;

// ---------------------------------------------------------------- tables
export const tenants = pgTable('tenants', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  status: tenantStatus('status').notNull().default('active'),
  /** Tenant data key encrypted with the master key (envelope encryption). */
  dataKeyEncrypted: text('data_key_encrypted'),
  settings: jsonb('settings').$type<JsonObject>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Users (ADR-011). `human` signs in to the Admin UI with a password; `service` (agent) only uses tokens.
 * Null `tenant_id` = platform admin (requires the `gateway-admin` role).
 */
export const users = pgTable(
  'users',
  {
    id: id(),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    /** Unique and immutable: becomes the principal's `sub`. */
    username: text('username').notNull().unique(),
    displayName: text('display_name'),
    kind: userKind('kind').notNull().default('human'),
    passwordHash: text('password_hash'),
    roles: text('roles').array().notNull().default(sql`'{}'::text[]`),
    groups: text('groups').array().notNull().default(sql`'{}'::text[]`),
    /** Attributes used in policy conditions (`claims.<attr>`). */
    attributes: jsonb('attributes').$type<JsonObject>().notNull().default({}),
    status: userStatus('status').notNull().default('active'),
    /** Language of the UI and of the messages returned to this user (ADR-012). */
    locale: userLocale('locale').notNull().default('en'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('users_tenant_idx').on(t.tenantId),
    check('users_platform_admin_ck', sql`${t.tenantId} is not null or 'gateway-admin' = any(${t.roles})`),
  ],
);

/** Opaque tokens (ADR-011): only the SHA-256 is stored. `name` becomes the principal's `clientId`. */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: apiTokenKind('kind').notNull().default('api'),
    /** Created by the user itself (`/me/tokens`): its name cannot impersonate an admin-issued client. */
    selfIssued: boolean('self_issued').notNull().default(false),
    tokenHash: text('token_hash').notNull().unique(),
    prefix: text('prefix').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('api_tokens_user_idx').on(t.userId)],
);

export const credentials = pgTable(
  'credentials',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    type: credentialType('type').notNull(),
    configEncrypted: text('config_encrypted').notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('credentials_tenant_name_uq').on(t.tenantId, t.name)],
);

/**
 * LLM configuration of the tenant (ADR-015), 1:1 with `tenants`. The API key is encrypted with the
 * tenant data key and never leaves the gateway; only its last characters are kept in clear (`api_key_hint`).
 */
export const tenantLlmSettings = pgTable('tenant_llm_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  provider: llmProvider('provider').notNull(),
  model: text('model').notNull(),
  /** Only for `openai_compatible`. */
  baseUrl: text('base_url'),
  apiKeyEncrypted: text('api_key_encrypted'),
  apiKeyHint: text('api_key_hint'),
  jsonMode: llmJsonMode('json_mode').notNull().default('schema'),
  maxGenerationsPerHour: integer('max_generations_per_hour').notNull().default(30),
  updatedBy: text('updated_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const upstreamSources = pgTable(
  'upstream_sources',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    openapiUrl: text('openapi_url'),
    openapiInline: jsonb('openapi_inline').$type<JsonObject>(),
    specFormat: sourceSpecFormat('spec_format').notNull().default('openapi'),
    /** Display-only metadata of the last import (format, date, counts); never user content. */
    importMeta: jsonb('import_meta').$type<JsonObject>(),
    baseUrl: text('base_url').notNull(),
    credentialId: uuid('credential_id').references(() => credentials.id, { onDelete: 'set null' }),
    crawlSchedule: text('crawl_schedule'),
    ownerTeam: text('owner_team'),
    status: sourceStatus('status').notNull().default('active'),
    settings: jsonb('settings').$type<JsonObject>().notNull().default({}),
    lastCrawlAt: timestamp('last_crawl_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('upstream_sources_tenant_name_uq').on(t.tenantId, t.name)],
);

export const tools = pgTable(
  'tools',
  {
    id: id(),
    tenantId: tenantId(),
    kind: toolKind('kind').notNull(),
    sourceId: uuid('source_id').references(() => upstreamSources.id, { onDelete: 'cascade' }),
    compositeDefId: uuid('composite_def_id'),
    /** Stable key of the operation in the source (method + path), used by the crawler to match versions. */
    operationKey: text('operation_key'),
    name: text('name').notNull(),
    title: text('title'),
    description: text('description').notNull().default(''),
    operationRef: jsonb('operation_ref').$type<OperationRef>(),
    inputSchema: jsonb('input_schema').$type<JsonObject>().notNull(),
    outputSchema: jsonb('output_schema').$type<JsonObject>(),
    annotations: jsonb('annotations').$type<ToolAnnotations>().notNull().default({}),
    state: toolState('state').notNull().default('disabled'),
    specHash: text('spec_hash'),
    version: integer('version').notNull().default(1),
    ownerTeam: text('owner_team'),
    overrides: jsonb('overrides').$type<JsonObject>().notNull().default({}),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    /** Text indexed for search (effective name/title/description, parameters and tags). Maintained by the repository. */
    searchText: text('search_text').notNull().default(''),
    /** Hash of the already vectorized text (optional embeddings, F7.1). */
    embeddingHash: text('embedding_hash'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Uniqueness over the effective name (owner override or generated name).
    uniqueIndex('tools_tenant_effective_name_uq').on(t.tenantId, sql`coalesce(${t.overrides}->>'name', ${t.name})`),
    uniqueIndex('tools_source_operation_uq')
      .on(t.sourceId, t.operationKey)
      .where(sql`${t.operationKey} is not null`),
    index('tools_tenant_state_idx').on(t.tenantId, t.state),
  ],
);

export const toolVersions = pgTable(
  'tool_versions',
  {
    id: id(),
    toolId: uuid('tool_id')
      .notNull()
      .references(() => tools.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    specHash: text('spec_hash'),
    inputSchema: jsonb('input_schema').$type<JsonObject>().notNull(),
    outputSchema: jsonb('output_schema').$type<JsonObject>(),
    diff: jsonb('diff').$type<JsonObject>(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('tool_versions_tool_version_uq').on(t.toolId, t.version)],
);

export const virtualServers = pgTable(
  'virtual_servers',
  {
    id: id(),
    tenantId: tenantId(),
    slug: text('slug').notNull(),
    name: text('name'),
    description: text('description'),
    /** Instructions sent in `initialize` (default: the description). */
    instructions: text('instructions'),
    toolSelector: jsonb('tool_selector').$type<JsonObject>().notNull().default({}),
    /** `full`: native tools at /mcp/s/:slug; `omni`: meta-tools (incremental discovery). */
    mode: text('mode', { enum: ['full', 'omni'] }).notNull().default('full'),
    icon: text('icon'),
    metadata: jsonb('metadata').$type<JsonObject>().notNull().default({}),
    ownerTeam: text('owner_team'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('virtual_servers_tenant_slug_uq').on(t.tenantId, t.slug)],
);

export const policies = pgTable(
  'policies',
  {
    id: id(),
    tenantId: tenantId(),
    subjectType: subjectType('subject_type').notNull(),
    subject: text('subject').notNull(),
    effect: policyEffect('effect').notNull(),
    toolPattern: text('tool_pattern').notNull(),
    conditions: jsonb('conditions').$type<JsonObject>().notNull().default({}),
    priority: integer('priority').notNull().default(0),
    description: text('description'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('policies_tenant_idx').on(t.tenantId)],
);

export const compositeDefinitions = pgTable('composite_definitions', {
  id: id(),
  tenantId: tenantId(),
  toolId: uuid('tool_id').references(() => tools.id, { onDelete: 'cascade' }),
  version: integer('version').notNull().default(1),
  inputSchema: jsonb('input_schema').$type<JsonObject>().notNull(),
  steps: jsonb('steps').$type<unknown[]>().notNull(),
  outputMapping: text('output_mapping'),
  failureMode: failureMode('failure_mode').notNull().default('abort'),
  timeoutMs: integer('timeout_ms').notNull().default(10000),
  dependsOnTools: uuid('depends_on_tools').array().notNull().default(sql`'{}'::uuid[]`),
  /** Original source (YAML/JSON) edited in the Composer. */
  source: text('source'),
  status: compositeStatus('status').notNull().default('draft'),
  /** Issues `{ path, message }`: `message` is a Message `{ key, params }` (ADR-012), or a plain string in legacy rows. */
  validationErrors: jsonb('validation_errors').$type<unknown[]>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const piiRules = pgTable(
  'pii_rules',
  {
    id: id(),
    tenantId: tenantId(),
    scope: piiScope('scope').notNull(),
    scopeRef: uuid('scope_ref'),
    detector: text('detector').notNull(),
    fieldSelector: text('field_selector'),
    strategy: piiStrategy('strategy').notNull(),
    direction: piiDirection('direction').notNull().default('both'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('pii_rules_tenant_idx').on(t.tenantId)],
);

export const projections = pgTable('projections', {
  id: id(),
  tenantId: tenantId(),
  toolId: uuid('tool_id')
    .notNull()
    .unique()
    .references(() => tools.id, { onDelete: 'cascade' }),
  include: text('include').array().notNull().default(sql`'{}'::text[]`),
  exclude: text('exclude').array().notNull().default(sql`'{}'::text[]`),
  maxArrayItems: integer('max_array_items'),
  maxBytes: integer('max_bytes'),
  allowAgentFields: boolean('allow_agent_fields').notNull().default(false),
  /** `suggested`: generated by the crawl, inactive until the owner approves it. */
  status: text('status', { enum: ['active', 'suggested'] }).notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** UI attached to a tool (ADR-022): `view-spec` `ToolViews`, 1:1 with the tool. */
export const toolViews = pgTable(
  'tool_views',
  {
    id: id(),
    tenantId: tenantId(),
    toolId: uuid('tool_id')
      .notNull()
      .unique()
      .references(() => tools.id, { onDelete: 'cascade' }),
    views: jsonb('views').$type<JsonObject>().notNull(),
    specVersion: integer('spec_version').notNull().default(1),
    /** `suggested`: inferred by the crawl, inactive until the owner approves it. */
    status: text('status', { enum: ['suggested', 'active', 'disabled'] }).notNull().default('suggested'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('tool_views_tenant_idx').on(t.tenantId, t.status)],
);

/** Branding of the tenant's views (ADR-022): validated `ThemeTokens` and the optional map basemap. */
export const tenantThemes = pgTable('tenant_themes', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  tokens: jsonb('tokens').$type<JsonObject>().notNull().default({}),
  tileUrl: text('tile_url'),
  tileAttribution: text('tile_attribution'),
  updatedAt: updatedAt(),
});

export const crawlRuns = pgTable(
  'crawl_runs',
  {
    id: id(),
    tenantId: tenantId(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => upstreamSources.id, { onDelete: 'cascade' }),
    status: crawlStatus('status').notNull().default('queued'),
    trigger: text('trigger').notNull().default('manual'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    stats: jsonb('stats').$type<JsonObject>().notNull().default({}),
    /** English error text (logs and fallback); the UI renders `errorKey` + `errorParams` (ADR-012). */
    error: text('error'),
    errorKey: text('error_key'),
    errorParams: jsonb('error_params').$type<JsonObject>(),
    createdAt: createdAt(),
  },
  (t) => [index('crawl_runs_source_idx').on(t.sourceId, t.createdAt)],
);

export const driftEvents = pgTable(
  'drift_events',
  {
    id: id(),
    tenantId: tenantId(),
    toolId: uuid('tool_id')
      .notNull()
      .references(() => tools.id, { onDelete: 'cascade' }),
    kind: driftKind('kind').notNull(),
    diff: jsonb('diff').$type<JsonObject>().notNull().default({}),
    acknowledgedBy: text('acknowledged_by'),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('drift_events_tenant_idx').on(t.tenantId, t.createdAt)],
);

/** Audit (F9.1): partitioned by month on `ts` (migration 0010); composite PK required by partitioning. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigserial('id', { mode: 'number' }).notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    tenantId: uuid('tenant_id'),
    action: text('action').notNull(),
    subject: text('subject'),
    clientId: text('client_id'),
    toolId: uuid('tool_id'),
    toolName: text('tool_name'),
    decision: text('decision'),
    statusCode: integer('status_code'),
    latencyMs: integer('latency_ms'),
    redactionsCount: integer('redactions_count'),
    projectedBytesSaved: integer('projected_bytes_saved'),
    artifactId: uuid('artifact_id'),
    traceId: text('trace_id'),
    /** Id of this call; composite steps point to the composite in `parent_call_id`. */
    callId: uuid('call_id'),
    parentCallId: uuid('parent_call_id'),
    details: jsonb('details').$type<JsonObject>(),
  },
  (t) => [primaryKey({ columns: [t.id, t.ts] }), index('audit_events_tenant_ts_idx').on(t.tenantId, t.ts)],
);

/**
 * Wide call events (F15, ADR-016): one row per call, partitioned by day on `ts` (migration 0018,
 * hand-written). Analytics only: never payloads, search queries or free text.
 */
export const callEvents = pgTable(
  'call_events',
  {
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    callId: uuid('call_id').notNull(),
    parentCallId: uuid('parent_call_id'),
    tenantId: uuid('tenant_id').notNull(),
    kind: text('kind').notNull(),
    endpoint: text('endpoint').notNull(),
    subject: text('subject').notNull(),
    clientId: text('client_id'),
    agentName: text('agent_name'),
    agentVersion: text('agent_version'),
    sessionKey: text('session_key'),
    sessionSource: text('session_source'),
    virtualServerId: uuid('virtual_server_id'),
    requestId: text('request_id'),
    jsonrpcId: text('jsonrpc_id'),
    protocolVersion: text('protocol_version'),
    traceId: text('trace_id'),
    spanId: text('span_id'),
    inboundParentSpanId: text('inbound_parent_span_id'),
    toolId: uuid('tool_id'),
    toolName: text('tool_name').notNull(),
    toolVersion: integer('tool_version'),
    toolKind: text('tool_kind'),
    sourceId: uuid('source_id'),
    viaOmni: boolean('via_omni').notNull().default(false),
    decision: text('decision').notNull(),
    errorCode: text('error_code'),
    errorStage: text('error_stage'),
    errorKey: text('error_key'),
    upstreamStatus: integer('upstream_status'),
    attempts: integer('attempts'),
    policyRuleId: text('policy_rule_id'),
    policyReason: text('policy_reason'),
    policyVersion: text('policy_version'),
    policyTrace: jsonb('policy_trace').$type<unknown[]>(),
    redactionsCount: integer('redactions_count').notNull().default(0),
    redactionsByDetector: jsonb('redactions_by_detector').$type<Record<string, number>>(),
    detokenizedCount: integer('detokenized_count').notNull().default(0),
    requestBytes: integer('request_bytes'),
    upstreamBytes: integer('upstream_bytes'),
    bytesBeforeProjection: integer('bytes_before_projection'),
    bytesAfterProjection: integer('bytes_after_projection'),
    responseBytes: integer('response_bytes'),
    projection: jsonb('projection').$type<JsonObject>(),
    artifactId: uuid('artifact_id'),
    artifactBytes: integer('artifact_bytes'),
    subjectRefsCount: integer('subject_refs_count').notNull().default(0),
    subjectRefsTruncated: boolean('subject_refs_truncated').notNull().default(false),
    meta: jsonb('meta').$type<JsonObject>(),
    argsHash: text('args_hash'),
    latencyMs: integer('latency_ms').notNull(),
    authzMs: integer('authz_ms'),
    validationMs: integer('validation_ms'),
    piiMs: integer('pii_ms'),
    upstreamMs: integer('upstream_ms'),
    projectionMs: integer('projection_ms'),
    artifactMs: integer('artifact_ms'),
    pluginsMs: integer('plugins_ms'),
    /** Gateway overhead: latency minus the upstream share (generated column). */
    overheadMs: integer('overhead_ms').generatedAlwaysAs(sql`greatest(latency_ms - coalesce(upstream_ms, 0), 0)`),
    defTokens: integer('def_tokens'),
    responseTokens: integer('response_tokens'),
    rawTokens: integer('raw_tokens'),
    tokensSavedProjection: integer('tokens_saved_projection').notNull().default(0),
    tokensSavedArtifact: integer('tokens_saved_artifact').notNull().default(0),
    catalogTokens: integer('catalog_tokens'),
    // reserved (ADR-016 §2): plugin pipeline, confirm gate, taint, pinning
    plugins: jsonb('plugins').$type<unknown[]>(),
    gate: jsonb('gate').$type<JsonObject>(),
    taint: jsonb('taint').$type<JsonObject>(),
    pinnedVersion: text('pinned_version'),
  },
  (t) => [
    primaryKey({ columns: [t.callId, t.ts] }),
    index('call_events_tenant_ts_idx').on(t.tenantId, t.ts),
    index('call_events_tenant_tool_ts_idx').on(t.tenantId, t.toolName, t.ts),
    index('call_events_tenant_session_ts_idx').on(t.tenantId, t.sessionKey, t.ts),
    index('call_events_parent_idx').on(t.parentCallId),
    index('call_events_tenant_trace_idx').on(t.tenantId, t.traceId),
  ],
);

/**
 * LGPD subject index (F15.11, ADR-017): HMAC fingerprints of identifiers seen per call, with the
 * who/what columns denormalized so the report outlives `call_events`. Monthly partitions (0020).
 */
export const callSubjectRefs = pgTable(
  'call_subject_refs',
  {
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    tenantId: uuid('tenant_id').notNull(),
    callId: uuid('call_id').notNull(),
    /** `*` marks a call with more subjects than the per-call cap (truncated). */
    detector: text('detector').notNull(),
    fp: bytea('fp').notNull(),
    direction: text('direction').notNull(),
    subject: text('subject').notNull(),
    clientId: text('client_id'),
    agentName: text('agent_name'),
    toolName: text('tool_name').notNull(),
    decision: text('decision').notNull(),
  },
  (t) => [index('call_subject_refs_tenant_fp_ts_idx').on(t.tenantId, t.fp, t.ts)],
);

/** Opt-in debug capture (F15.17, ADR-017): metadata only, the payloads are encrypted in S3. */
export const debugCaptures = pgTable(
  'debug_captures',
  {
    id: id(),
    tenantId: tenantId(),
    createdBy: text('created_by').notNull(),
    reason: text('reason').notNull(),
    filter: jsonb('filter').$type<{ tool?: string; subject?: string; clientId?: string; sessionKey?: string }>().notNull().default({}),
    maxCalls: integer('max_calls').notNull(),
    capturedCount: integer('captured_count').notNull().default(0),
    status: text('status').$type<'active' | 'stopped' | 'expired'>().notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('debug_captures_tenant_status_idx').on(t.tenantId, t.status, t.expiresAt)],
);

export const debugCaptureItems = pgTable(
  'debug_capture_items',
  {
    callId: uuid('call_id').primaryKey(),
    tenantId: tenantId(),
    captureId: uuid('capture_id')
      .notNull()
      .references(() => debugCaptures.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    objectKey: text('object_key').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('debug_capture_items_tenant_idx').on(t.tenantId, t.createdAt), index('debug_capture_items_expires_idx').on(t.expiresAt)],
);

/** Agent analytics (F15.21, ADR-016 §15): bad patterns found per session. */
export const agentFindings = pgTable(
  'agent_findings',
  {
    id: id(),
    tenantId: tenantId(),
    type: text('type').notNull(),
    sessionId: text('session_id').notNull(),
    sessionKey: text('session_key').notNull(),
    subject: text('subject').notNull(),
    agentName: text('agent_name'),
    tool: text('tool').notNull(),
    related: text('related').array().notNull().default(sql`'{}'::text[]`),
    count: integer('count').notNull(),
    detail: text('detail'),
    firstCallId: uuid('first_call_id').notNull(),
    lastCallId: uuid('last_call_id').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('agent_findings_unique').on(t.tenantId, t.type, t.firstCallId, t.tool), index('agent_findings_tenant_at_idx').on(t.tenantId, t.at)],
);

/** Co-usage: how often a tool follows another, per day (F15.21). */
export const toolTransitionsDaily = pgTable(
  'tool_transitions_daily',
  {
    tenantId: tenantId(),
    day: date('day').notNull(),
    fromTool: text('from_tool').notNull(),
    toTool: text('to_tool').notNull(),
    count: integer('count').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.day, t.fromTool, t.toTool] })],
);

/** Frequent sequences proposed as composite drafts (F15.21). */
export const compositeSuggestions = pgTable(
  'composite_suggestions',
  {
    id: id(),
    tenantId: tenantId(),
    sequenceHash: text('sequence_hash').notNull(),
    sequence: text('sequence').array().notNull(),
    sessions: integer('sessions').notNull(),
    subjects: integer('subjects').notNull(),
    share: real('share').notNull(),
    status: text('status').$type<'open' | 'accepted' | 'dismissed'>().notNull().default('open'),
    compositeId: uuid('composite_id'),
    firstSeen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('composite_suggestions_unique').on(t.tenantId, t.sequenceHash), index('composite_suggestions_tenant_status_idx').on(t.tenantId, t.status)],
);

/** Task outcomes reported by clients (report_outcome, F15.22). */
export const callOutcomes = pgTable(
  'call_outcomes',
  {
    id: id(),
    tenantId: tenantId(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    source: text('source').$type<'tool' | 'api'>().notNull(),
    sessionKey: text('session_key'),
    subject: text('subject').notNull(),
    clientId: text('client_id'),
    agentName: text('agent_name'),
    virtualServerId: uuid('virtual_server_id'),
    outcome: text('outcome').notNull(),
    reasonCode: text('reason_code'),
    callIds: uuid('call_ids').array().notNull().default(sql`'{}'::uuid[]`),
    tools: text('tools').array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [index('call_outcomes_tenant_ts_idx').on(t.tenantId, t.ts), index('call_outcomes_session_idx').on(t.tenantId, t.sessionKey, t.ts)],
);

/** PII token vault (`tokenize` strategy): value encrypted with the tenant's data key. */
export const piiTokens = pgTable(
  'pii_tokens',
  {
    token: text('token').primaryKey(),
    tenantId: tenantId(),
    detector: text('detector').notNull(),
    valueEncrypted: text('value_encrypted').notNull(),
    /** Subjects (`sub`) the token was shown to: only they can turn it back into the value. Empty = legacy row. */
    subjects: text('subjects').array().notNull().default(sql`'{}'::text[]`),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('pii_tokens_tenant_expires_idx').on(t.tenantId, t.expiresAt)],
);

/** Artifacts (F8): large responses stored in S3, already redacted and projected. */
export const artifacts = pgTable(
  'artifacts',
  {
    id: id(),
    tenantId: tenantId(),
    sessionId: text('session_id').notNull(),
    toolCallId: uuid('tool_call_id'),
    toolName: text('tool_name'),
    uri: text('uri').notNull(),
    objectKey: text('object_key').notNull(),
    contentType: text('content_type').notNull().default('application/json'),
    sizeBytes: integer('size_bytes').notNull(),
    rowCount: integer('row_count'),
    schemaSummary: jsonb('schema_summary').$type<JsonObject>(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('artifacts_tenant_session_idx').on(t.tenantId, t.sessionId, t.createdAt), index('artifacts_expires_idx').on(t.expiresAt)],
);

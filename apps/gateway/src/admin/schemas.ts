import { credentialInputSchema, CREDENTIAL_TYPES } from '@mcp-gateway/core';
import { LOCALES } from '@mcp-gateway/i18n';
import { z } from 'zod';

export const isoDate = z.iso.datetime({ offset: true });
export const nullableIsoDate = isoDate.nullable();
export const jsonObject = z.record(z.string(), z.unknown());
export const uuidParam = z.object({ id: z.uuid() });

export const errorSchema = z
  .object({ error: z.string(), message: z.string(), details: z.unknown().optional() })
  .meta({ id: 'Error' });

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), total: z.number().int() });

export const errorResponses = {
  400: errorSchema,
  401: errorSchema,
  403: errorSchema,
  404: errorSchema,
  409: errorSchema,
} as const;

// ------------------------------------------------------------- tenants
export const tenantSchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    status: z.enum(['active', 'suspended']),
    settings: jsonObject,
    createdAt: isoDate,
    updatedAt: isoDate,
  })
  .meta({ id: 'Tenant' });

export const tenantCreateSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'slug: lowercase letters, digits and hyphens'),
  name: z.string().min(1),
  settings: jsonObject.optional(),
});

export const tenantPatchSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  settings: jsonObject.optional(),
});

// ------------------------------------------------------------- credentials
export const credentialSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    type: z.enum(CREDENTIAL_TYPES as [string, ...string[]]),
    config: jsonObject.describe('Non-secret fields only'),
    rotatedAt: nullableIsoDate,
    createdAt: isoDate,
    updatedAt: isoDate,
  })
  .meta({ id: 'Credential' });

export const credentialCreateSchema = z.intersection(z.object({ name: z.string().min(1) }), credentialInputSchema);

export const credentialPatchSchema = z.object({
  name: z.string().min(1).optional(),
  config: jsonObject.optional().describe('Replaces the whole configuration (rotation)'),
});

// ------------------------------------------------------------- sources
const httpUrl = z.url({ protocol: /^https?$/ });

export const sourceSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    openapiUrl: z.string().nullable(),
    hasInlineSpec: z.boolean(),
    specFormat: z.enum(['openapi', 'postman']).describe('Format behind openapiUrl; Postman collections are converted on every crawl (ADR-014)'),
    importMeta: jsonObject.nullable().describe('Last import (format, date, operation counts)'),
    baseUrl: z.string(),
    credentialId: z.uuid().nullable(),
    crawlSchedule: z.string().nullable(),
    ownerTeam: z.string().nullable(),
    status: z.enum(['active', 'paused', 'error']),
    settings: jsonObject,
    lastCrawlAt: nullableIsoDate,
    createdAt: isoDate,
    updatedAt: isoDate,
  })
  .meta({ id: 'Source' });

const sourceName = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'name: snake_case, up to 32 chars (becomes the tool prefix)');

export const sourceCreateSchema = z.object({
  name: sourceName,
  openapiUrl: httpUrl.optional(),
  openapiInline: jsonObject.optional(),
  specFormat: z.enum(['openapi', 'postman']).optional(),
  baseUrl: httpUrl,
  credentialId: z.uuid().nullable().optional(),
  crawlSchedule: z.string().nullable().optional().describe('Cron expression (e.g. "0 */6 * * *")'),
  ownerTeam: z.string().nullable().optional(),
  status: z.enum(['active', 'paused']).optional(),
  settings: jsonObject.optional(),
});

export const sourcePatchSchema = sourceCreateSchema.partial().extend({
  openapiUrl: httpUrl.nullable().optional(),
  openapiInline: jsonObject.nullable().optional(),
});

// ------------------------------------------------------------- source import (ADR-014)
const importInputSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('text'),
      text: z.string().min(1).describe('OpenAPI (JSON/YAML), one or more cURL commands, a Postman collection or a HAR file'),
      format: z.enum(['auto', 'openapi', 'curl', 'postman', 'har']).default('auto'),
    }),
    z.object({
      kind: z.literal('url'),
      url: httpUrl,
      format: z.enum(['auto', 'openapi', 'postman']).default('auto'),
      credentialId: z.uuid().nullable().optional().describe('Credential used to download the document'),
    }),
  ])
  .meta({ id: 'ImportInput' });

const operationKeys = z
  .array(z.string().regex(/^[A-Z]+ \/.*$/, 'operation key: "METHOD /path"'))
  .max(500)
  .describe('Operations to import ("METHOD /path"); all when omitted');

export const importPreviewBodySchema = z.object({
  input: importInputSchema,
  targetSourceId: z.uuid().optional().describe('Existing source to compare against (merge)'),
  sourceName: sourceName.optional().describe('Source name used for the tool names (default: the suggested name)'),
  include: operationKeys.optional(),
});

export const importBodySchema = z.object({
  input: importInputSchema,
  include: operationKeys.optional(),
  target: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('new'),
      name: sourceName,
      baseUrl: httpUrl,
      credentialId: z.uuid().nullable().optional(),
      crawlSchedule: z.string().nullable().optional(),
      ownerTeam: z.string().nullable().optional(),
    }),
    z.object({
      kind: z.literal('existing'),
      sourceId: z.uuid(),
      mode: z.enum(['add', 'replace']).default('add').describe('add keeps existing operations; replace overwrites them'),
    }),
  ]),
});

const importWarning = z.object({ key: z.string(), message: z.string() });
const importFormat = z.enum(['openapi', 'curl', 'postman', 'har']);

export const importPreviewSchema = z
  .object({
    format: importFormat,
    specVersion: z.string(),
    suggestedName: z.string().nullable(),
    baseUrlCandidates: z.array(z.string()),
    suggestedCredential: z.object({ type: z.string(), in: z.enum(['header', 'query']).optional(), name: z.string().optional() }).nullable(),
    warnings: z.array(importWarning),
    operations: z.array(
      z.object({
        key: z.string(),
        summary: z.string().nullable(),
        tags: z.array(z.string()),
        status: z.enum(['new', 'unchanged', 'conflict']).describe('Against the target source: conflict = exists and differs'),
        toolName: z.string().nullable(),
        skipped: z.enum(['deprecated', 'x-mcp-ignore']).nullable(),
      }),
    ),
    tools: z.array(
      z.object({
        operationKey: z.string(),
        name: z.string(),
        title: z.string(),
        description: z.string(),
        inputSchema: jsonObject,
        annotations: jsonObject,
      }),
    ),
  })
  .meta({ id: 'ImportPreview' });

export const crawlRunSchema = z
  .object({
    id: z.uuid(),
    sourceId: z.uuid(),
    status: z.enum(['queued', 'running', 'succeeded', 'failed']),
    trigger: z.string(),
    startedAt: nullableIsoDate,
    finishedAt: nullableIsoDate,
    stats: jsonObject,
    error: z.string().nullable(),
    createdAt: isoDate,
  })
  .meta({ id: 'CrawlRun' });

export const importResultSchema = z
  .object({
    source: sourceSchema,
    crawlRun: crawlRunSchema,
    added: z.array(z.string()),
    replaced: z.array(z.string()),
    conflicts: z.array(z.string()),
    warnings: z.array(importWarning),
  })
  .meta({ id: 'ImportResult' });

export const noContent = { 204: z.null().describe('No content') } as const;

// ------------------------------------------------------------- tools
export const toolStateEnum = z.enum(['disabled', 'enabled', 'deprecated', 'removed']);
export const toolKindEnum = z.enum(['openapi', 'manual', 'composite']);

export const toolSchema = z
  .object({
    id: z.uuid(),
    kind: toolKindEnum,
    sourceId: z.uuid().nullable(),
    name: z.string().describe('Effective name (with override)'),
    baseName: z.string().describe('Name generated by the crawler'),
    title: z.string().nullable(),
    description: z.string(),
    operationRef: z
      .object({ method: z.string(), path: z.string(), operationId: z.string().optional() })
      .nullable(),
    inputSchema: jsonObject.describe('Effective input schema (with override)'),
    outputSchema: jsonObject.nullable(),
    annotations: z.object({
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    }),
    state: toolStateEnum,
    specHash: z.string().nullable(),
    version: z.number().int(),
    ownerTeam: z.string().nullable(),
    overrides: jsonObject,
    createdAt: isoDate,
    updatedAt: isoDate,
  })
  .meta({ id: 'Tool' });

export const toolQuery = pageQuery.extend({
  sourceId: z.uuid().optional(),
  state: toolStateEnum.optional(),
  ownerTeam: z.string().optional(),
  kind: toolKindEnum.optional(),
  q: z.string().optional(),
});

export const toolPatchSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/, 'name: up to 64 chars [a-zA-Z0-9_-]')
      .nullable()
      .optional(),
    title: z.string().max(200).nullable().optional(),
    description: z.string().max(4000).nullable().optional(),
    inputSchema: jsonObject.nullable().optional().describe('JSON Merge Patch over the generated schema'),
  })
  .describe('Owner overrides. `null` removes the field override.');

export const toolVersionSchema = z
  .object({
    version: z.number().int(),
    specHash: z.string().nullable(),
    inputSchema: jsonObject,
    outputSchema: jsonObject.nullable(),
    diff: jsonObject.nullable(),
    createdAt: isoDate,
  })
  .meta({ id: 'ToolVersion' });

// ------------------------------------------------------------- virtual servers
export const toolSelectorSchema = z.object({
  tools: z.array(z.string()).optional().describe('Tool ids or names'),
  patterns: z.array(z.string()).optional().describe('Globs over the name (e.g. rh_colaboradores_*)'),
  tags: z.array(z.string()).optional().describe('Tools with any of these tags'),
  kinds: z.array(z.enum(['openapi', 'manual', 'composite'])).optional().describe('Restricts to these kinds'),
});

export const virtualServerSchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string().nullable(),
    description: z.string().nullable(),
    instructions: z.string().nullable(),
    toolSelector: toolSelectorSchema.passthrough(),
    mode: z.enum(['full', 'omni']),
    icon: z.string().nullable(),
    metadata: jsonObject,
    ownerTeam: z.string().nullable(),
    endpoints: z.object({ mcp: z.string(), omni: z.string() }),
    createdAt: isoDate,
    updatedAt: isoDate,
  })
  .meta({ id: 'VirtualServer' });

export const virtualServerCreateSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  instructions: z.string().max(8000).nullable().optional().describe('Sent on initialize (default: description)'),
  toolSelector: toolSelectorSchema.default({}),
  mode: z.enum(['full', 'omni']).default('full'),
  icon: z.string().max(64).nullable().optional(),
  metadata: jsonObject.optional(),
  ownerTeam: z.string().nullable().optional(),
});

export const virtualServerPatchSchema = virtualServerCreateSchema
  .partial()
  .extend({ toolSelector: toolSelectorSchema.optional(), mode: z.enum(['full', 'omni']).optional() });

export const snippetsSchema = z
  .object({
    endpoints: z.object({ mcp: z.string(), omni: z.string() }),
    snippets: z.object({ claude: z.string(), claudeJson: jsonObject, generic: z.string() }),
  })
  .meta({ id: 'McpSnippets' });

// ------------------------------------------------------------- policies
export const policySchema = z
  .object({
    id: z.uuid(),
    subjectType: z.enum(['role', 'client', 'user', 'group']),
    subject: z.string(),
    effect: z.enum(['allow', 'deny']),
    toolPattern: z.string(),
    conditions: jsonObject,
    priority: z.number().int(),
    description: z.string().nullable(),
    createdAt: isoDate,
    updatedAt: isoDate,
  })
  .meta({ id: 'Policy' });

export const policyCreateSchema = z.object({
  subjectType: z.enum(['role', 'client', 'user', 'group']),
  subject: z.string().min(1).describe('Subject value; `*` = any'),
  effect: z.enum(['allow', 'deny']),
  toolPattern: z.string().min(1).describe('Glob over the name or `annotation:<hint>`'),
  conditions: jsonObject.optional().describe('{ timeWindows?, args?, rate? }'),
  priority: z.number().int().optional(),
  description: z.string().nullable().optional(),
});

export const policyPatchSchema = policyCreateSchema.partial();

export const simulateSchema = z.object({
  subject: z.object({
    sub: z.string().default('simulated'),
    clientId: z.string().optional(),
    roles: z.array(z.string()).default([]),
    groups: z.array(z.string()).default([]),
    claims: jsonObject.default({}),
  }),
  tool: z.string().describe('Effective tool name'),
  args: jsonObject.optional(),
  mode: z.enum(['list', 'call']).default('call'),
  at: isoDate.optional().describe('Evaluation time (default: now)'),
});

export const decisionSchema = z
  .object({
    effect: z.enum(['allow', 'deny']),
    reason: z.string(),
    ruleId: z.string().nullable(),
    explanation: z.string(),
    rule: policySchema.nullable(),
    obligations: z.object({ rateLimits: z.array(z.object({ ruleId: z.string(), limit: z.number(), windowSec: z.number() })) }),
    trace: z.array(z.object({ ruleId: z.string(), effect: z.enum(['allow', 'deny']), matched: z.boolean(), note: z.string() })),
    tool: z.object({ id: z.uuid(), name: z.string(), state: toolStateEnum, annotations: jsonObject }),
  })
  .meta({ id: 'PolicyDecision' });

// ------------------------------------------------------------- PII
export const piiRuleSchema = z
  .object({
    id: z.uuid(),
    scope: z.enum(['global', 'source', 'tool']),
    scopeRef: z.uuid().nullable(),
    detector: z.string(),
    fieldSelector: z.string().nullable(),
    strategy: z.enum(['mask', 'hash', 'drop', 'tokenize']),
    direction: z.enum(['request', 'response', 'both']),
    createdAt: isoDate,
    updatedAt: isoDate,
  })
  .meta({ id: 'PiiRule' });

export const piiRuleCreateSchema = z.object({
  scope: z.enum(['global', 'source', 'tool']),
  scopeRef: z.uuid().nullable().optional(),
  detector: z.string().min(1).describe('cpf, cnpj, pis, email, telefone, salario… or `field` with fieldSelector'),
  fieldSelector: z.string().nullable().optional().describe('Field name or JSONPath ($.items[*].cpf)'),
  strategy: z.enum(['mask', 'hash', 'drop', 'tokenize']),
  direction: z.enum(['request', 'response', 'both']).default('both'),
});

export const piiRulePatchSchema = piiRuleCreateSchema.partial();

export const piiPreviewSchema = z.object({
  payload: z.unknown(),
  toolId: z.uuid().optional(),
  direction: z.enum(['request', 'response']).default('response'),
  /** Draft rules (replace the saved ones in the preview). */
  rules: z.array(piiRuleCreateSchema).optional(),
});

// ------------------------------------------------------------- projections
const selectorList = z.array(z.string().regex(/^\$/, 'JSONPath must start with $')).max(200);

export const projectionSchema = z
  .object({
    toolId: z.uuid(),
    include: z.array(z.string()),
    exclude: z.array(z.string()),
    maxArrayItems: z.number().int().nullable(),
    maxBytes: z.number().int().nullable(),
    allowAgentFields: z.boolean(),
    status: z.enum(['active', 'suggested']),
    updatedAt: isoDate,
  })
  .meta({ id: 'Projection' });

export const projectionPutSchema = z.object({
  include: selectorList.default([]),
  exclude: selectorList.default([]),
  maxArrayItems: z.number().int().positive().max(100_000).nullable().default(null),
  maxBytes: z.number().int().min(1024).nullable().default(null),
  allowAgentFields: z.boolean().default(false),
  status: z.enum(['active', 'suggested']).default('active'),
});

export const projectionPreviewSchema = z.object({
  payload: z.unknown().describe('Sample response (structured form of the tool)'),
  projection: projectionPutSchema.optional().describe('Draft; default: the saved projection'),
  fields: z.array(z.string()).optional(),
});

// ------------------------------------------------------------- manual tools (F7b.1)
export const manualToolSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'name: snake_case, up to 64 chars'),
  title: z.string().max(200).optional(),
  description: z.string().min(1).max(4000),
  sourceId: z.uuid(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().regex(/^\//),
  params: z
    .array(
      z.object({
        name: z.string().min(1),
        in: z.enum(['path', 'query', 'header']),
        field: z.string().optional(),
        required: z.boolean().optional(),
        schema: jsonObject.optional(),
        description: z.string().optional(),
      }),
    )
    .default([]),
  body: z
    .object({
      schema: jsonObject,
      mode: z.enum(['flatten', 'field']).optional(),
      field: z.string().optional(),
      contentType: z.string().optional(),
      required: z.boolean().optional(),
    })
    .optional(),
  outputSchema: jsonObject.optional(),
  exampleResponse: z.unknown().optional().describe('Sample response used to infer the output schema'),
  annotations: z
    .object({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional(), idempotentHint: z.boolean().optional() })
    .optional(),
  ownerTeam: z.string().nullable().optional(),
});

// ------------------------------------------------------------- composites (F7b)
export const compositeWriteSchema = z.object({
  source: z.union([z.string().min(1), jsonObject]).describe('Definition as YAML/JSON (text) or object'),
  ownerTeam: z.string().nullable().optional(),
});

export const issueSchema = z.object({ path: z.string(), message: z.string() });

export const compositeGraphSchema = z
  .object({
    nodes: z.array(z.object({ id: z.string(), tool: z.string(), level: z.number().int(), conditional: z.boolean(), foreach: z.boolean() })),
    edges: z.array(z.object({ from: z.string(), to: z.string() })),
  })
  .meta({ id: 'CompositeGraph' });

export const compositeValidationSchema = z
  .object({
    valid: z.boolean(),
    errors: z.array(issueSchema),
    warnings: z.array(issueSchema),
    levels: z.array(z.array(z.string())),
    dependsOn: z.array(z.string()).describe('Names of the tools used'),
    annotations: jsonObject,
    graph: compositeGraphSchema.optional(),
  })
  .meta({ id: 'CompositeValidation' });

// ------------------------------------------------------------- natural-language composer (F14.5, ADR-015)
export const composerGenerateSchema = z.object({
  prompt: z.string().trim().min(1).max(2000).describe('What the composite should do, in natural language'),
  previous: z.string().max(20_000).optional().describe('Current definition (YAML) to refine'),
  refinement: z.string().trim().min(1).max(2000).optional().describe('Change requested to `previous`'),
  tools: z.array(z.string().min(1)).max(10).optional().describe('Tool names that must be offered to the model'),
});

export const composerProposalSchema = z
  .object({
    proposal: z.object({
      source: z.string().describe('Generated definition (YAML); may be invalid, see `validation`'),
      explanation: z.string(),
      assumptions: z.array(z.string()),
      unsupported: z.string().nullable(),
    }),
    validation: compositeValidationSchema,
    candidates: z.array(z.object({ name: z.string(), state: toolStateEnum, score: z.number().nullable() })),
    usage: z.object({
      provider: z.string(),
      model: z.string(),
      attempts: z.number().int(),
      inputTokens: z.number().int(),
      outputTokens: z.number().int(),
      cacheReadTokens: z.number().int(),
      durationMs: z.number(),
    }),
  })
  .meta({ id: 'ComposerProposal' });

export const compositeSchema = z
  .object({
    id: z.uuid(),
    toolId: z.uuid().nullable(),
    name: z.string(),
    state: toolStateEnum.nullable(),
    status: z.enum(['draft', 'valid', 'invalid']),
    version: z.number().int(),
    source: z.string().nullable(),
    definition: jsonObject,
    validationErrors: z.array(z.unknown()),
    dependsOnTools: z.array(z.string()),
    updatedAt: isoDate,
  })
  .meta({ id: 'Composite' });

export const dryRunSchema = z.object({
  input: jsonObject.default({}),
  subject: z
    .object({
      sub: z.string().default('dry-run'),
      clientId: z.string().optional(),
      roles: z.array(z.string()).default([]),
      groups: z.array(z.string()).default([]),
      claims: jsonObject.default({}),
    })
    .optional()
    .describe('Simulated subject (default: the caller)'),
  allowWrites: z.boolean().default(false).describe('Required if any step changes data'),
});

// ------------------------------------------------------------- audit (F9.1)
export const auditQuery = pageQuery.extend({
  action: z.string().optional(),
  toolId: z.uuid().optional(),
  toolName: z.string().optional(),
  clientId: z.string().optional(),
  subject: z.string().optional(),
  decision: z.enum(['allow', 'deny', 'error', 'applied', 'rejected', 'invalid']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const auditEventSchema = z
  .object({
    id: z.number(),
    ts: isoDate,
    action: z.string(),
    subject: z.string().nullable(),
    clientId: z.string().nullable(),
    toolId: z.string().nullable(),
    toolName: z.string().nullable(),
    decision: z.string().nullable(),
    statusCode: z.number().nullable(),
    latencyMs: z.number().nullable(),
    redactionsCount: z.number().nullable(),
    projectedBytesSaved: z.number().nullable(),
    artifactId: z.string().nullable(),
    traceId: z.string().nullable(),
    callId: z.string().nullable(),
    parentCallId: z.string().nullable(),
    details: jsonObject.nullable(),
  })
  .meta({ id: 'AuditEvent' });

// ------------------------------------------------------------- UI (F10)
export const localeSchema = z.enum(LOCALES).describe('UI and message language (ADR-012)');

export const meSchema = z.object({
  sub: z.string(),
  name: z.string().nullable(),
  tenant: z.string().nullable(),
  roles: z.array(z.string()),
  groups: z.array(z.string()),
  isAdmin: z.boolean(),
  isOwner: z.boolean(),
  locale: localeSchema,
  publicUrl: z.string().describe('Public base URL of the gateway, used to build MCP client snippets'),
});

export const mePatchSchema = z.object({ locale: localeSchema });

export const driftEventSchema = z
  .object({
    id: z.uuid(),
    toolId: z.uuid(),
    toolName: z.string(),
    ownerTeam: z.string().nullable(),
    kind: z.enum(['added', 'changed', 'removed', 'breaking']),
    diff: jsonObject,
    acknowledgedBy: z.string().nullable(),
    acknowledgedAt: nullableIsoDate,
    createdAt: isoDate,
  })
  .meta({ id: 'DriftEvent' });

export const driftQuery = pageQuery.extend({
  kind: z.enum(['added', 'changed', 'removed', 'breaking']).optional(),
  // z.coerce.boolean('false') === true, hence the explicit enum
  pending: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  toolId: z.uuid().optional(),
});

export const playgroundSchema = z.object({
  tool: z.string(),
  arguments: jsonObject.default({}),
  subject: z
    .object({
      sub: z.string().default('playground'),
      clientId: z.string().optional(),
      roles: z.array(z.string()).default([]),
      groups: z.array(z.string()).default([]),
      claims: jsonObject.default({}),
    })
    .optional(),
  /** Simulates an MCP client with MCP Apps (ADR-022): results carry their views; destructive views ask for confirmation. */
  ui: z.boolean().default(false),
  /** Request `_meta` of a simulated view call (confirmation token, origin). */
  meta: jsonObject.optional(),
});

export const playgroundResultSchema = z.object({
  decision: z.string(),
  result: z.unknown(),
  final: z.unknown().describe('Final response (after redaction/projection), as the agent receives it'),
  raw: z.unknown().nullable().describe('Raw upstream response (gateway-admin only)'),
  rawVisible: z.boolean(),
  status: z.number().nullable(),
  redactions: z.number(),
  bytesSaved: z.number(),
  artifactId: z.string().nullable(),
  durationMs: z.number(),
});

// ------------------------------------------------------------- users and tokens (ADR-011)
const name64 = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._@-]{1,63}$/, 'letters, digits, ".", "_", "@" and "-"');
const password = z.string().min(8, 'password: at least 8 characters').max(256);

export const userSchema = z
  .object({
    id: z.uuid(),
    username: z.string(),
    displayName: z.string().nullable(),
    kind: z.enum(['human', 'service']),
    roles: z.array(z.string()),
    groups: z.array(z.string()),
    attributes: jsonObject,
    status: z.enum(['active', 'disabled']),
    locale: localeSchema,
    hasPassword: z.boolean(),
    createdAt: isoDate,
    updatedAt: isoDate,
  })
  .meta({ id: 'User' });

export const userCreateSchema = z.object({
  username: name64,
  displayName: z.string().min(1).nullable().optional(),
  kind: z.enum(['human', 'service']).default('human'),
  password: password.optional().describe('Only for `human` users'),
  roles: z.array(z.string().min(1)).default([]),
  groups: z.array(z.string().min(1)).default([]),
  attributes: jsonObject.optional().describe('Available in policy conditions as `claims.*`'),
  locale: localeSchema.default('en'),
});

export const userPatchSchema = z.object({
  displayName: z.string().min(1).nullable().optional(),
  roles: z.array(z.string().min(1)).optional(),
  groups: z.array(z.string().min(1)).optional(),
  attributes: jsonObject.optional(),
  status: z.enum(['active', 'disabled']).optional(),
  locale: localeSchema.optional(),
});

export const passwordSchema = z.object({ password });

export const apiTokenSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    prefix: z.string(),
    expiresAt: nullableIsoDate,
    lastUsedAt: nullableIsoDate,
    createdAt: isoDate,
  })
  .meta({ id: 'ApiToken' });

export const apiTokenCreateSchema = z.object({
  name: name64.describe('Becomes the principal `clientId` (`client` policies)'),
  expiresInDays: z.number().int().min(1).max(3650).optional().describe('No value = never expires'),
});

/** A user's own tokens always expire: a stolen session cannot leave a permanent token behind. */
export const meTokenCreateSchema = z.object({
  name: name64.describe('The principal `clientId` becomes `me/<name>`: it never matches an admin-issued client'),
  expiresInDays: z.number().int().min(1).max(365).default(90),
});

export const apiTokenCreatedSchema = apiTokenSchema
  .extend({ token: z.string().describe('Token value; shown only in this response') })
  .meta({ id: 'ApiTokenCreated' });

export const tokenParams = z.object({ id: z.uuid(), tokenId: z.uuid() });

export const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });
export const loginResultSchema = z.object({ token: z.string(), expiresAt: isoDate });

/** First-run setup (ADR-024). */
export const setupStatusSchema = z.object({
  needed: z.boolean().describe('The instance has no user yet'),
  enabled: z.boolean().describe('SETUP_TOKEN is configured on the gateway'),
});
export const setupSchema = z.object({
  setupToken: z.string().min(1).describe('Value of the SETUP_TOKEN environment variable'),
  username: name64,
  password,
  locale: localeSchema.default('en'),
  tenant: tenantCreateSchema.pick({ slug: true, name: true }),
});
export const setupResultSchema = loginResultSchema.extend({ tenant: z.string().describe('Slug of the tenant created') });

// ------------------------------------------------------------- LLM settings (F14.3, ADR-015)
export const llmProviderEnum = z.enum(['anthropic', 'openai', 'openai_compatible']);
export const llmJsonModeEnum = z.enum(['schema', 'object']);

export const llmSettingsSchema = z
  .object({
    configured: z.boolean(),
    provider: llmProviderEnum.optional(),
    model: z.string().optional(),
    baseUrl: z.string().nullable().optional(),
    hasApiKey: z.boolean().optional(),
    apiKeyHint: z.string().nullable().optional().describe('Last characters of the key; the key itself is write-only'),
    jsonMode: llmJsonModeEnum.optional(),
    maxGenerationsPerHour: z.number().int().optional(),
    updatedBy: z.string().nullable().optional(),
    updatedAt: isoDate.optional(),
  })
  .meta({ id: 'LlmSettings' });

export const llmSettingsPutSchema = z.object({
  provider: llmProviderEnum,
  model: z.string().trim().min(1).max(200),
  baseUrl: z.url({ protocol: /^https?$/ }).nullable().optional().describe('Required for openai_compatible; ignored otherwise'),
  apiKey: z.string().trim().min(1).max(1000).nullable().optional().describe('Omit to keep the current key, null to remove it'),
  jsonMode: llmJsonModeEnum.optional().describe('openai_compatible only: strict json_schema or plain json_object'),
  maxGenerationsPerHour: z.number().int().min(1).max(1000).optional(),
});

export const llmSettingsTestSchema = llmSettingsPutSchema.partial();

export const llmTestResultSchema = z
  .object({ ok: z.boolean(), latencyMs: z.number(), error: z.string().optional() })
  .meta({ id: 'LlmTestResult' });

export const readinessQuery = z.object({
  roles: z
    .string()
    .default('agent')
    .transform((s) => [...new Set(s.split(',').map((r) => r.trim()).filter(Boolean))].slice(0, 10))
    .describe('Comma-separated roles that should reach the composite'),
});

export const compositeReadinessSchema = z
  .object({
    composite: z.object({ id: z.uuid(), toolId: z.uuid(), name: z.string(), state: toolStateEnum, status: z.enum(['draft', 'valid', 'invalid']) }),
    steps: z.array(z.object({ id: z.string(), tool: z.string(), toolId: z.uuid().nullable(), state: toolStateEnum.nullable(), canManage: z.boolean() })),
    roles: z.array(z.string()),
    access: z.array(z.object({ tool: z.string(), role: z.string(), effect: z.enum(['allow', 'deny']), reason: z.string(), explanation: z.string() })),
    canCreatePolicies: z.boolean(),
    virtualServers: z.array(z.object({ id: z.uuid(), slug: z.string(), name: z.string().nullable(), canManage: z.boolean(), includes: z.boolean() })),
    ready: z.boolean().describe('Composite and steps enabled and every role allowed on all of them'),
  })
  .meta({ id: 'CompositeReadiness' });

// ------------------------------------------------------------- analytics (F15.9)
export const analyticsQueryBody = z
  .record(z.string(), z.unknown())
  .describe('AnalyticsQuery: { metric, groupBy?, filters?, range: { last } | { from, to }, limit?, order? }')
  .meta({ id: 'AnalyticsQuery' });

export const analyticsResultSchema = z
  .object({
    metric: z.string(),
    groupBy: z.array(z.string()),
    from: isoDate,
    to: isoDate,
    rows: z.array(z.object({ keys: z.record(z.string(), z.string().nullable()), value: z.number().nullable() })),
  })
  .meta({ id: 'AnalyticsResult' });

// ------------------------------------------------------------- LGPD subject access (F15.11)
export const SUBJECT_DETECTORS = ['cpf', 'cnpj', 'pis', 'email', 'telefone'] as const;

export const subjectAccessBody = z
  .object({
    detector: z.enum(SUBJECT_DETECTORS),
    value: z.string().min(1).max(320).describe('Identifier of the data subject (never stored or logged)'),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .meta({ id: 'SubjectAccessQuery' });

const subjectAccessRow = z.object({
  ts: isoDate,
  callId: z.string(),
  tool: z.string(),
  subject: z.string(),
  clientId: z.string().nullable(),
  agentName: z.string().nullable(),
  decision: z.string(),
  direction: z.string(),
});
const countRow = z.object({ value: z.string().nullable(), calls: z.number() });

export const subjectAccessResult = z
  .object({
    detector: z.string(),
    fingerprint: z.string(),
    from: isoDate,
    to: isoDate,
    total: z.number(),
    matches: z.array(subjectAccessRow),
    summary: z.object({ subjects: z.array(countRow), agents: z.array(countRow), clients: z.array(countRow), tools: z.array(countRow) }),
    possibleMatches: z.array(subjectAccessRow),
  })
  .meta({ id: 'SubjectAccessReport' });

// ------------------------------------------------------------- analytics views (F15.12)
export const viewQuery = z.object({ last: z.enum(['1h', '24h', '7d', '30d']).default('7d') });
export const observabilitySettingsBody = jsonObject.meta({ id: 'ObservabilitySettings' });

// ------------------------------------------------------------- call explorer (F15.13)
export const callsQuery = z.object({
  tool: z.string().max(200).optional(),
  kind: z.enum(['tool', 'composite_step', 'meta', 'list', 'artifact', 'outcome']).optional(),
  decision: z.enum(['allow', 'deny', 'error']).optional(),
  errorCode: z.string().max(64).optional(),
  client: z.string().max(200).optional(),
  agent: z.string().max(64).optional(),
  session: z.string().max(80).optional(),
  trace: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const callIdParam = z.object({ callId: z.uuid() });

// ------------------------------------------------------------- debug capture (F15.17)
export const debugCaptureBody = z
  .object({
    reason: z.string().trim().min(3).max(500).describe('Why the capture is needed (audited)'),
    filter: z
      .object({
        tool: z.string().max(200).optional(),
        subject: z.string().max(200).optional(),
        clientId: z.string().max(200).optional(),
        sessionKey: z.string().max(80).optional(),
      })
      .default({}),
    maxCalls: z.number().int().min(1).max(100).default(20),
    minutes: z.number().int().min(1).max(1440).default(15),
  })
  .meta({ id: 'DebugCaptureInput' });

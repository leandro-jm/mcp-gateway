import type { Locale } from '@mcp-gateway/i18n';

export type ToolState = 'disabled' | 'enabled' | 'deprecated' | 'removed';
export type ToolKind = 'openapi' | 'manual' | 'composite';

export interface Page<T> {
  items: T[];
  total: number;
}

export interface Me {
  sub: string;
  name: string | null;
  tenant: string | null;
  roles: string[];
  groups: string[];
  isAdmin: boolean;
  isOwner: boolean;
  locale: Locale;
}

export interface User {
  id: string;
  username: string;
  displayName: string | null;
  kind: 'human' | 'service';
  roles: string[];
  groups: string[];
  attributes: Record<string, unknown>;
  status: 'active' | 'disabled';
  locale: Locale;
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface ApiTokenCreated extends ApiToken {
  token: string;
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: string;
  settings: Record<string, unknown>;
}

export interface Tool {
  id: string;
  kind: ToolKind;
  sourceId: string | null;
  name: string;
  baseName: string;
  title: string | null;
  description: string;
  operationRef: { method: string; path: string; operationId?: string } | null;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  state: ToolState;
  version: number;
  ownerTeam: string | null;
  overrides: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ToolVersion {
  version: number;
  specHash: string | null;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  diff: { summary?: string; changes?: Array<{ kind: string; path: string; breaking: boolean }> } | null;
  createdAt: string;
}

export interface Source {
  id: string;
  name: string;
  openapiUrl: string | null;
  hasInlineSpec: boolean;
  specFormat: 'openapi' | 'postman';
  importMeta: { format?: ImportFormat; input?: 'text' | 'url'; importedAt?: string; operations?: number; merges?: number } | null;
  baseUrl: string;
  credentialId: string | null;
  crawlSchedule: string | null;
  ownerTeam: string | null;
  status: string;
  lastCrawlAt: string | null;
}

export type ImportFormat = 'openapi' | 'curl' | 'postman' | 'har';

export type ImportInput =
  | { kind: 'text'; text: string; format?: ImportFormat | 'auto' }
  | { kind: 'url'; url: string; format?: 'auto' | 'openapi' | 'postman'; credentialId?: string | null };

export interface ImportWarning {
  key: string;
  message: string;
}

export interface ImportPreview {
  format: ImportFormat;
  specVersion: string;
  suggestedName: string | null;
  baseUrlCandidates: string[];
  suggestedCredential: { type: string; in?: 'header' | 'query'; name?: string } | null;
  warnings: ImportWarning[];
  operations: Array<{
    key: string;
    summary: string | null;
    tags: string[];
    status: 'new' | 'unchanged' | 'conflict';
    toolName: string | null;
    skipped: 'deprecated' | 'x-mcp-ignore' | null;
  }>;
  tools: Array<{ operationKey: string; name: string; title: string; description: string; inputSchema: Record<string, unknown>; annotations: Record<string, unknown> }>;
}

export interface ImportResult {
  source: Source;
  crawlRun: CrawlRun;
  added: string[];
  replaced: string[];
  conflicts: string[];
  warnings: ImportWarning[];
}

export interface CrawlRun {
  id: string;
  sourceId: string;
  status: string;
  trigger: string;
  startedAt: string | null;
  finishedAt: string | null;
  stats: Record<string, unknown>;
  error: string | null;
  createdAt: string;
}

export interface Credential {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  rotatedAt: string | null;
}

export interface Projection {
  toolId: string;
  include: string[];
  exclude: string[];
  maxArrayItems: number | null;
  maxBytes: number | null;
  allowAgentFields: boolean;
  status: 'active' | 'suggested';
}

export interface Policy {
  id: string;
  subjectType: 'role' | 'client' | 'user' | 'group';
  subject: string;
  effect: 'allow' | 'deny';
  toolPattern: string;
  conditions: Record<string, unknown>;
  priority: number;
  description: string | null;
}

export interface Decision {
  effect: 'allow' | 'deny';
  reason: string;
  ruleId: string | null;
  explanation: string;
  rule: Policy | null;
  obligations: { rateLimits: Array<{ ruleId: string; limit: number; windowSec: number }> };
  trace: Array<{ ruleId: string; effect: string; matched: boolean; note: string }>;
}

export interface PiiRule {
  id: string;
  scope: 'global' | 'source' | 'tool';
  scopeRef: string | null;
  detector: string;
  fieldSelector: string | null;
  strategy: 'mask' | 'hash' | 'drop' | 'tokenize';
  direction: 'request' | 'response' | 'both';
}

export interface VirtualServer {
  id: string;
  slug: string;
  name: string | null;
  description: string | null;
  instructions: string | null;
  toolSelector: { tools?: string[]; patterns?: string[]; tags?: string[]; kinds?: ToolKind[] };
  mode: 'full' | 'omni';
  icon: string | null;
  ownerTeam: string | null;
  endpoints: { mcp: string; omni: string };
}

export interface Snippets {
  endpoints: { mcp: string; omni: string };
  snippets: { claude: string; claudeJson: Record<string, unknown>; generic: string };
}

export interface Composite {
  id: string;
  toolId: string | null;
  name: string;
  state: ToolState | null;
  status: 'draft' | 'valid' | 'invalid';
  version: number;
  source: string | null;
  validationErrors: Array<{ path: string; message: string }>;
}

export interface CompositeValidation {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
  warnings: Array<{ path: string; message: string }>;
  levels: string[][];
  dependsOn: string[];
  annotations: Record<string, unknown>;
  graph?: CompositeGraph;
}

export interface DriftEvent {
  id: string;
  toolId: string;
  toolName: string;
  ownerTeam: string | null;
  kind: 'added' | 'changed' | 'removed' | 'breaking';
  diff: { summary?: string; changes?: Array<{ kind: string; path: string; breaking: boolean }>; fromVersion?: number | null; toVersion?: number | null };
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  createdAt: string;
}

export interface AuditEvent {
  id: number;
  ts: string;
  action: string;
  subject: string | null;
  clientId: string | null;
  toolName: string | null;
  decision: string | null;
  statusCode: number | null;
  latencyMs: number | null;
  redactionsCount: number | null;
  projectedBytesSaved: number | null;
  artifactId: string | null;
  traceId: string | null;
  callId: string | null;
  parentCallId: string | null;
  details: Record<string, unknown> | null;
}

export interface PlaygroundResult {
  decision: string;
  final: unknown;
  raw: unknown;
  rawVisible: boolean;
  status: number | null;
  redactions: number;
  bytesSaved: number;
  artifactId: string | null;
  durationMs: number;
}

// ------------------------------------------------------------- natural-language composer (F14, ADR-015)
export type LlmProvider = 'anthropic' | 'openai' | 'openai_compatible';

export interface LlmSettings {
  configured: boolean;
  provider?: LlmProvider;
  model?: string;
  baseUrl?: string | null;
  hasApiKey?: boolean;
  apiKeyHint?: string | null;
  jsonMode?: 'schema' | 'object';
  maxGenerationsPerHour?: number;
  updatedBy?: string | null;
  updatedAt?: string;
}

export interface LlmTestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface CompositeGraph {
  nodes: Array<{ id: string; tool: string; level: number; conditional: boolean; foreach: boolean }>;
  edges: Array<{ from: string; to: string }>;
}

export interface ComposerProposal {
  proposal: { source: string; explanation: string; assumptions: string[]; unsupported: string | null };
  validation: CompositeValidation;
  candidates: Array<{ name: string; state: ToolState; score: number | null }>;
  usage: { provider: string; model: string; attempts: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; durationMs: number };
}

export interface CompositeReadiness {
  composite: { id: string; toolId: string; name: string; state: ToolState; status: Composite['status'] };
  steps: Array<{ id: string; tool: string; toolId: string | null; state: ToolState | null; canManage: boolean }>;
  roles: string[];
  access: Array<{ tool: string; role: string; effect: 'allow' | 'deny'; reason: string; explanation: string }>;
  canCreatePolicies: boolean;
  virtualServers: Array<{ id: string; slug: string; name: string | null; canManage: boolean; includes: boolean }>;
  ready: boolean;
}

// ------------------------------------------------------------- observability (F15)
export type ViewRange = '1h' | '24h' | '7d' | '30d';

export interface SreView {
  from: string;
  to: string;
  totals: { calls: number; errorRate: number | null; latencyP95: number | null; overheadP95: number | null; upstreamAvg: number | null };
  overTime: Array<{ ts: string; calls: number; latencyP95: number | null; overheadP95: number | null; upstreamAvg: number | null }>;
  errorsBySource: Array<{ source: string | null; calls: number }>;
  errorsByStage: Array<{ stage: string | null; calls: number }>;
  circuitOpen: Array<{ source: string | null; calls: number }>;
  stages: Record<string, number | null>;
}

export interface ToolsView {
  usage: Array<{ tool: string; calls: number; errors: number; agents: number; retries: number; validationErrors: number }>;
  byAgent: Array<{ tool: string | null; agent: string | null; calls: number }>;
  neverUsed: Array<{ tool: string; kind: string; ownerTeam: string | null }>;
  driftImpact: Array<{ tool: string; kind: string; at: string; errorRateBefore: number | null; errorRateAfter: number | null }>;
}

export interface SecurityView {
  denials: Array<{ tool: string | null; calls: number }>;
  denialsByRule: Array<{ ruleId: string | null; reason: string | null; tool: string; calls: number }>;
  redactionsByDetector: Record<string, number>;
  anomalies: Array<{ key: string; hour: string; calls: number; baseline: number; score: number; dimension: 'client' | 'agent' }>;
}

export interface UsageRow {
  key: string | null;
  calls: number;
  errors: number;
  denies: number;
  responseTokens: number;
  tokensSaved: number;
}

export interface FinopsView {
  pricing: { currency: string; inputPerMTok: number };
  tokens: { response: number; saved: number; savedByMechanism: { projection: number; artifact: number; omni: number } };
  money: { currency: string; saved: number; spent: number };
  beforeAfter: { withoutGateway: number; withGateway: number; savedPct: number; moneySaved: number };
  usageByClient: UsageRow[];
  usageByAgent: UsageRow[];
  usageBySubject: UsageRow[];
}

export interface SubjectAccessRow {
  ts: string;
  callId: string;
  tool: string;
  subject: string;
  clientId: string | null;
  agentName: string | null;
  decision: string;
  direction: string;
}

export interface SubjectAccessReport {
  detector: string;
  fingerprint: string;
  total: number;
  matches: SubjectAccessRow[];
  summary: Record<'subjects' | 'agents' | 'clients' | 'tools', Array<{ value: string | null; calls: number }>>;
  possibleMatches: SubjectAccessRow[];
}

export interface ObservabilitySettings {
  tracePropagation: { inbound: boolean; outbound: boolean };
  issueSessionId: boolean;
  pricing: { currency: string; inputPerMTok: number };
  subjectIndex: { enabled: boolean; detectors: string[]; maxPerCall: number };
  outcomeTool: 'off' | 'omni' | 'all';
}

export interface CallSummary {
  ts: string;
  callId: string;
  parentCallId: string | null;
  kind: string;
  endpoint: string;
  subject: string;
  clientId: string | null;
  agentName: string | null;
  sessionKey: string | null;
  traceId: string | null;
  tool: { id: string | null; name: string; kind: string | null; viaOmni: boolean };
  decision: string;
  error: { code: string; stage: string | null; key: string | null } | null;
  upstream: { status: number | null; attempts: number | null };
  latencyMs: number;
  overheadMs: number | null;
  redactionsCount: number;
  responseTokens: number | null;
  tokensSaved: number;
}

export interface CallExplanation {
  call: CallSummary;
  stages: Array<{ stage: string; ms: number }>;
  policy: {
    decision: string;
    ruleId: string | null;
    reason: string | null;
    trace: Array<{ ruleId: string; effect: string; matched: boolean; note: string }> | null;
    current: { effect: string; ruleId: string | null; reason: string } | null;
    policyChanged: boolean | null;
  };
  data: {
    redactionsCount: number;
    redactionsByDetector: Record<string, number>;
    bytes: Record<string, number | null>;
    projection: { cutBytes: number; cutPct: number } | null;
    artifact: { id: string; bytes: number | null } | null;
  };
  tokens: { definition: number | null; response: number | null; savedProjection: number; savedArtifact: number };
  children: CallSummary[];
  traceUrl: string | null;
}

export interface CapturedCall {
  callId: string;
  tool: string;
  args: unknown;
  upstream?: { status: number; body: unknown };
  steps?: Array<{ stepId: string; tool: string; status: number; body: unknown }>;
  final: unknown;
}

export interface ReplayResult {
  original: { decision: string; redactions: number; responseBytes: number | null; final: unknown };
  replayed: { decision: string; redactions: number; responseBytes: number | null; final: unknown; wouldOffload: boolean };
  deltas: { decisionChanged: boolean; redactions: number; responseBytes: number | null; responseTokens: number | null };
}

export interface DebugCapture {
  id: string;
  createdBy: string;
  reason: string;
  filter: { tool?: string; subject?: string };
  maxCalls: number;
  capturedCount: number;
  status: string;
  expiresAt: string;
}

export interface SessionSummary {
  sessionKey: string;
  subject: string;
  agentName: string | null;
  endpoint: string;
  start: string;
  end: string;
  calls: number;
  errors: number;
  tools: number;
}

export interface AgentFinding {
  id: string;
  type: 'loop' | 'thrash' | 'search_miss' | 'abandoned';
  sessionKey: string;
  subject: string;
  agentName: string | null;
  tool: string;
  related: string[];
  count: number;
  detail: string | null;
  firstCallId: string;
  at: string;
}

export interface Trajectory {
  sessionKey: string;
  segments: Array<{ start: string; end: string; events: CallSummary[] }>;
  findings: AgentFinding[];
}

export interface CompositeSuggestion {
  id: string;
  sequence: string[];
  sessions: number;
  subjects: number;
  share: number;
  status: 'open' | 'accepted' | 'dismissed';
  compositeId: string | null;
  draft: string | null;
}

export interface OutcomesView {
  totals: Record<string, number>;
  byTool: Array<{ tool: string; successRate: number | null }>;
  byVirtualServer: Array<{ virtualServer: string | null; successRate: number | null }>;
  recent: Array<{ ts: string; outcome: string; reasonCode: string | null; agentName: string | null; tools: string[]; source: string }>;
}

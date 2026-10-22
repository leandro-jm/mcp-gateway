import { ArtifactStore } from '@mcp-gateway/artifacts';
import type { AnalyticsStore, CallEvent } from '@mcp-gateway/call-analytics';
import { redact } from '@mcp-gateway/redaction';
import { CRAWL_QUEUE, decodeKey } from '@mcp-gateway/core';
import {
  AgentAnalyticsRepo,
  ApiTokensRepo,
  ArtifactsRepo,
  AuditRepo,
  AuthQueries,
  CallEventsRepo,
  CallEventWriter,
  PgAnalyticsStore,
  PlatformUsageQueries,
  RollupWriter,
  SubjectRefsRepo,
  CompositesRepo,
  DebugCaptureMaintenance,
  DebugCapturesRepo,
  CrawlRunsRepo,
  DriftEventsRepo,
  createDb,
  PiiRulesRepo,
  PiiTokensRepo,
  PoliciesRepo,
  ProjectionsRepo,
  ToolViewsRepo,
  TenantThemesRepo,
  SystemQueries,
  CredentialsRepo,
  Keyring,
  LlmSettingsRepo,
  DecisionSettingsRepo,
  SourcesRepo,
  TenantsRepo,
  ToolsRepo,
  UsersRepo,
  VirtualServersRepo,
  type AuditInput,
  type Db,
  type DbHandle,
} from '@mcp-gateway/db';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { TokenVerifier } from './auth/tokens';
import type { GatewayConfig } from './config';
import { createLlmProvider, type LlmProviderFactory } from './llm';
import type { Logger } from './logger';
import { createDecisionProvider, RedisDecisionCache, ToolRouter, type DecisionCache, type DecisionProviderFactory } from './router';
import { CredentialManager } from './proxy/credentials';
import { ToolExecutor } from './proxy/executor';
import { CircuitBreaker, RateLimiter } from './proxy/guards';
import { ArtifactService } from './proxy/artifacts';
import { DebugCaptureService } from './proxy/debug-capture';
import { PiiService } from './proxy/pii';
import { RestAdapter } from './proxy/rest-adapter';
import { ArgValidator } from './proxy/validation';
import { SessionStore } from './mcp/sessions';
import { RegistryCache } from './registry/cache';
import { HttpEmbeddingProvider, type EmbeddingProvider } from './search/embeddings';
import { ToolSearch } from './search/tool-search';
import { Metrics } from './telemetry/metrics';
import { createTracing, type TracingHandle } from './telemetry/tracing';
import { createPgCallEventSink } from './telemetry/call-events/pg-sink';
import type { CallEventSink } from './telemetry/call-events/sink';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';

export interface Repos {
  tenants: TenantsRepo;
  sources: SourcesRepo;
  credentials: CredentialsRepo;
  crawlRuns: CrawlRunsRepo;
  tools: ToolsRepo;
  virtualServers: VirtualServersRepo;
  audit: AuditRepo;
  policies: PoliciesRepo;
  piiRules: PiiRulesRepo;
  piiTokens: PiiTokensRepo;
  projections: ProjectionsRepo;
  toolViews: ToolViewsRepo;
  tenantThemes: TenantThemesRepo;
  system: SystemQueries;
  composites: CompositesRepo;
  drift: DriftEventsRepo;
  artifacts: ArtifactsRepo;
  users: UsersRepo;
  apiTokens: ApiTokensRepo;
  auth: AuthQueries;
  llmSettings: LlmSettingsRepo;
  decisionSettings: DecisionSettingsRepo;
  callEvents: CallEventsRepo;
  callEventWriter: CallEventWriter;
  rollups: RollupWriter;
  subjectRefs: SubjectRefsRepo;
  platformUsage: PlatformUsageQueries;
  debugCaptures: DebugCapturesRepo;
  debugMaintenance: DebugCaptureMaintenance;
  agentAnalytics: AgentAnalyticsRepo;
}

export interface Services {
  config: GatewayConfig;
  logger: Logger;
  db: Db;
  dbHandle: DbHandle;
  redis: Redis;
  verifier: TokenVerifier;
  rateLimiter: RateLimiter;
  keyring: Keyring;
  repos: Repos;
  queues: { crawl: Queue };
  registry: RegistryCache;
  credentialManager: CredentialManager;
  executor: ToolExecutor;
  pii: PiiService;
  search: ToolSearch;
  sessions: SessionStore;
  artifacts: ArtifactService;
  /** Builds the tenant's LLM client for the natural-language composer (ADR-015). */
  llm: LlmProviderFactory;
  /** Builds the tenant's decision-model client for the tool router (ADR-025). */
  decisions: DecisionProviderFactory;
  /** Decision-model tool router; absent when `TOOL_ROUTER_ENABLED` is off (no behavior change). */
  router?: ToolRouter;
  metrics: Metrics;
  tracing: TracingHandle;
  /** Analytics sink for call events (ADR-016). */
  callEvents: CallEventSink;
  /** Analytics queries over the rollups (F15.9). */
  analytics: AnalyticsStore;
  /** Opt-in debug capture (F15.17). */
  debug: DebugCaptureService;
  /** Starts background connections (registry invalidation subscription). */
  start(): Promise<void>;
  close(): Promise<void>;
}

/** Audit never stores clear-text PII (F9.1): subject, client and details go through redaction. */
const AUDIT_KEY = Buffer.alloc(32, 0);
export function sanitizeAudit(event: AuditInput): AuditInput {
  const pick = { subject: event.subject, clientId: event.clientId, toolName: event.toolName, details: event.details };
  const { value } = redact(pick, { direction: 'request', rules: [], key: AUDIT_KEY });
  return { ...event, ...value } as AuditInput;
}

/**
 * Call events get the same treatment (F15.7): subject, client and the self-declared agent name
 * go through redaction with the audit key, so a subject reads the same in both stores.
 */
export function sanitizeCallEvent(event: CallEvent): CallEvent {
  return sanitizeIdentity(event);
}

/** Who called, as analytics stores it (same sanitization as the audit): subject, client and agent. */
export function sanitizeIdentity<T extends { subject: string; clientId?: string | null; agentName?: string | null }>(who: T): T {
  return { ...who, ...(redact({ subject: who.subject, clientId: who.clientId ?? null, agentName: who.agentName ?? null }, { direction: 'request', rules: [], key: AUDIT_KEY }).value as object) };
}

export function sanitizeSubject(subject: string): string {
  return sanitizeIdentity({ subject }).subject;
}

export function createRepos(db: Db, keyring: Keyring): Repos {
  return {
    tenants: new TenantsRepo(db),
    sources: new SourcesRepo(db),
    credentials: new CredentialsRepo(db, keyring),
    crawlRuns: new CrawlRunsRepo(db),
    tools: new ToolsRepo(db),
    virtualServers: new VirtualServersRepo(db),
    audit: new AuditRepo(db, sanitizeAudit),
    policies: new PoliciesRepo(db),
    piiRules: new PiiRulesRepo(db),
    piiTokens: new PiiTokensRepo(db),
    projections: new ProjectionsRepo(db),
    toolViews: new ToolViewsRepo(db),
    tenantThemes: new TenantThemesRepo(db),
    system: new SystemQueries(db),
    composites: new CompositesRepo(db),
    drift: new DriftEventsRepo(db),
    artifacts: new ArtifactsRepo(db),
    users: new UsersRepo(db),
    apiTokens: new ApiTokensRepo(db),
    auth: new AuthQueries(db),
    llmSettings: new LlmSettingsRepo(db, keyring),
    decisionSettings: new DecisionSettingsRepo(db, keyring),
    callEvents: new CallEventsRepo(db),
    callEventWriter: new CallEventWriter(db),
    rollups: new RollupWriter(db),
    subjectRefs: new SubjectRefsRepo(db),
    platformUsage: new PlatformUsageQueries(db),
    debugCaptures: new DebugCapturesRepo(db),
    debugMaintenance: new DebugCaptureMaintenance(db),
    agentAnalytics: new AgentAnalyticsRepo(db),
  };
}

export function createServices(
  config: GatewayConfig,
  logger: Logger,
  overrides: {
    embeddings?: EmbeddingProvider;
    spanProcessors?: SpanProcessor[];
    llm?: LlmProviderFactory;
    callEventSink?: CallEventSink;
    decisions?: DecisionProviderFactory;
    decisionCache?: DecisionCache;
  } = {},
): Services {
  const dbHandle = createDb(config.DATABASE_URL);
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const keyring = new Keyring(dbHandle.db, decodeKey(config.GATEWAY_MASTER_KEY));
  const crawl = new Queue(CRAWL_QUEUE, { connection: redis });
  const repos = createRepos(dbHandle.db, keyring);
  const verifier = new TokenVerifier(repos.auth);
  const rateLimiter = new RateLimiter(redis);
  const registry = new RegistryCache(dbHandle.db, repos, redis, logger);
  const credentialManager = new CredentialManager(repos.credentials, keyring, redis, logger);
  // Credential rotation (or any tenant change) drops local caches.
  registry.onInvalidate((tenantId) => credentialManager.forgetTenant(tenantId));
  const pii = new PiiService(keyring, repos.piiTokens);
  const store =
    config.S3_ENDPOINT && config.S3_BUCKET
      ? new ArtifactStore({
          endpoint: config.S3_ENDPOINT,
          region: config.S3_REGION,
          accessKeyId: config.S3_ACCESS_KEY ?? '',
          secretAccessKey: config.S3_SECRET_KEY ?? '',
          bucket: config.S3_BUCKET,
        })
      : undefined;
  const artifacts = new ArtifactService(repos.artifacts, logger, store);
  const debug = new DebugCaptureService(
    repos.debugCaptures,
    repos.debugMaintenance,
    keyring,
    logger,
    { enabled: config.DEBUG_CAPTURE_ENABLED, retentionHours: config.DEBUG_CAPTURE_RETENTION_HOURS },
    store,
  );
  const metrics = new Metrics({ defaultMetrics: config.NODE_ENV !== 'test' });
  const tracing = createTracing({
    ...(config.OTEL_EXPORTER_OTLP_ENDPOINT ? { otlpEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
    ...(overrides.spanProcessors ? { processors: overrides.spanProcessors } : {}),
  });
  const callEvents = overrides.callEventSink ?? createPgCallEventSink(repos.callEventWriter, config, metrics, logger, sanitizeCallEvent);
  const embeddings =
    overrides.embeddings ??
    (config.EMBEDDINGS_URL ? new HttpEmbeddingProvider(config.EMBEDDINGS_URL, config.EMBEDDINGS_MODEL, config.EMBEDDINGS_API_KEY) : undefined);
  const search = new ToolSearch(repos.tools, logger, embeddings);
  const decisions = overrides.decisions ?? createDecisionProvider;
  const router = config.TOOL_ROUTER_ENABLED
    ? new ToolRouter({
        settingsRepo: repos.decisionSettings,
        providers: decisions,
        cache: overrides.decisionCache ?? new RedisDecisionCache(redis),
        budget: rateLimiter,
        circuit: new CircuitBreaker(),
        pii,
        logger,
        allowPrivateNetworks: config.NETWORK_ALLOW_PRIVATE,
        search,
      })
    : undefined;
  if (router) registry.onInvalidate((tenantId) => router.forgetTenant(tenantId));
  const executor = new ToolExecutor({
    adapter: new RestAdapter(credentialManager),
    validator: new ArgValidator(),
    rateLimiter,
    circuit: new CircuitBreaker(),
    audit: repos.audit,
    pii,
    artifacts,
    logger,
    metrics,
    tracer: tracing.tracer,
    sink: callEvents,
    debug,
    allowPrivateNetworks: config.NETWORK_ALLOW_PRIVATE,
  });
  return {
    config,
    logger,
    db: dbHandle.db,
    dbHandle,
    redis,
    verifier,
    rateLimiter,
    keyring,
    repos,
    queues: { crawl },
    registry,
    credentialManager,
    executor,
    pii,
    search,
    sessions: new SessionStore(),
    artifacts,
    llm: overrides.llm ?? createLlmProvider,
    decisions,
    ...(router ? { router } : {}),
    metrics,
    tracing,
    callEvents,
    analytics: new PgAnalyticsStore(dbHandle.db),
    debug,
    async start() {
      await registry.start();
      await artifacts.init();
    },
    async close() {
      await this.sessions.closeAll();
      await registry.stop();
      await crawl.close();
      artifacts.close();
      await callEvents.close();
      await tracing.shutdown();
      redis.disconnect();
      await dbHandle.close();
    },
  };
}

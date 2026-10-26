import { z } from 'zod';

/** Drift webhook configured on the tenant (optionally restricted to an owner_team). */
export const driftWebhookSchema = z.object({
  id: z.string().min(1).describe('Stable webhook identifier (idempotency)'),
  url: z.url({ protocol: /^https?$/ }),
  ownerTeam: z.string().optional().describe('Only events of tools owned by this team'),
  events: z.array(z.enum(['added', 'changed', 'removed', 'breaking'])).default(['breaking', 'removed']),
  /** Secret for the HMAC-SHA256 signature (`X-Gateway-Signature`). */
  secret: z.string().optional(),
});

export type DriftWebhook = z.output<typeof driftWebhookSchema>;

/**
 * `tenants.settings`. Unknown fields are preserved (each phase adds its own).
 * Lenient reading: invalid entries are ignored instead of taking down the data plane.
 */
export const tenantSettingsSchema = z
  .object({
    webhooks: z.array(driftWebhookSchema).default([]),
  })
  .passthrough();

export type TenantSettings = z.output<typeof tenantSettingsSchema>;

export function readWebhooks(settings: unknown): DriftWebhook[] {
  const raw = (settings as { webhooks?: unknown })?.webhooks;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((w) => {
    const r = driftWebhookSchema.safeParse(w);
    return r.success ? [r.data] : [];
  });
}

// ---------------------------------------------------------------- traffic (F3.4)

export const rateLimitSchema = z.object({
  limit: z.number().int().positive(),
  windowSec: z.number().int().positive().max(24 * 3600).default(60),
});
export type RateLimit = z.output<typeof rateLimitSchema>;

export const trafficSettingsSchema = z.object({
  rateLimits: z
    .object({
      perTenant: rateLimitSchema.nullable().default({ limit: 6000, windowSec: 60 }),
      perClient: rateLimitSchema.nullable().default({ limit: 600, windowSec: 60 }),
      perTool: rateLimitSchema.nullable().default({ limit: 600, windowSec: 60 }),
      /** Specific limits per tool name (override `perTool`). */
      tools: z.record(z.string(), rateLimitSchema).default({}),
    })
    .default({ perTenant: { limit: 6000, windowSec: 60 }, perClient: { limit: 600, windowSec: 60 }, perTool: { limit: 600, windowSec: 60 }, tools: {} }),
  limits: z
    .object({
      // ceilings protect the shared process: a tenant admin must not be able to exhaust its memory
      maxRequestBytes: z.number().int().positive().max(5 * 1024 * 1024).default(1024 * 1024),
      maxResponseBytes: z.number().int().positive().max(64 * 1024 * 1024).default(10 * 1024 * 1024),
    })
    .default({ maxRequestBytes: 1024 * 1024, maxResponseBytes: 10 * 1024 * 1024 }),
  circuitBreaker: z
    .object({
      failureThreshold: z.number().int().positive().default(5),
      windowMs: z.number().int().positive().default(30_000),
      cooldownMs: z.number().int().positive().default(30_000),
    })
    .default({ failureThreshold: 5, windowMs: 30_000, cooldownMs: 30_000 }),
});

export type TrafficSettings = z.output<typeof trafficSettingsSchema>;

/** Reads the traffic settings; invalid values fall back to the defaults instead of taking down the data plane. */
export function readTrafficSettings(settings: unknown): TrafficSettings {
  const s = (settings ?? {}) as Record<string, unknown>;
  const parsed = trafficSettingsSchema.safeParse({
    rateLimits: s.rateLimits,
    limits: s.limits,
    circuitBreaker: s.circuitBreaker,
  });
  return parsed.success ? parsed.data : trafficSettingsSchema.parse({});
}

// ---------------------------------------------------------------- PII (F5)

export const piiSettingsSchema = z.object({
  /** Extra field-name synonyms per detector (e.g. { salario: ['valor_bruto'] }). */
  synonyms: z.record(z.string(), z.array(z.string())).default({}),
  /** Lifetime of PII tokens (tokenize strategy). */
  tokenTtlSeconds: z.number().int().positive().max(30 * 24 * 3600).default(24 * 3600),
  /** Tenant's bank account regex (`conta` detector, by value). */
  bankAccountPattern: z.string().optional(),
});

export type PiiSettings = z.output<typeof piiSettingsSchema>;

export function readPiiSettings(settings: unknown): PiiSettings {
  const parsed = piiSettingsSchema.safeParse((settings as { pii?: unknown } | null)?.pii ?? {});
  return parsed.success ? parsed.data : piiSettingsSchema.parse({});
}

// ---------------------------------------------------------------- composition (F7b.4)

export const compositionSettingsSchema = z.object({
  maxSteps: z.number().int().positive().max(100).default(20),
  maxCalls: z.number().int().positive().max(5000).default(100),
  maxIntermediateBytes: z.number().int().positive().max(64 * 1024 * 1024).default(5 * 1024 * 1024),
});

export type CompositionSettings = z.output<typeof compositionSettingsSchema>;

export function readCompositionSettings(settings: unknown): CompositionSettings {
  const parsed = compositionSettingsSchema.safeParse((settings as { composition?: unknown } | null)?.composition ?? {});
  return parsed.success ? parsed.data : compositionSettingsSchema.parse({});
}

// ---------------------------------------------------------------- artifacts (F8)

export const artifactSettingsSchema = z.object({
  /** Responses larger than this (after redaction/projection) become an artifact. */
  thresholdBytes: z.number().int().positive().default(32 * 1024),
  ttlSeconds: z.number().int().positive().max(7 * 24 * 3600).default(24 * 3600),
  previewItems: z.number().int().min(0).max(20).default(3),
  /** Maximum size of an artifact. */
  maxBytes: z.number().int().positive().max(64 * 1024 * 1024).default(50 * 1024 * 1024),
});

export type ArtifactSettings = z.output<typeof artifactSettingsSchema>;

export function readArtifactSettings(settings: unknown): ArtifactSettings {
  const parsed = artifactSettingsSchema.safeParse((settings as { artifacts?: unknown } | null)?.artifacts ?? {});
  return parsed.success ? parsed.data : artifactSettingsSchema.parse({});
}

// ---------------------------------------------------------------- observability (F15, ADR-016)

export const observabilitySettingsSchema = z.object({
  /** W3C trace context: accept from `_meta`/header (inbound) and send to the upstream (outbound). */
  tracePropagation: z
    .object({ inbound: z.boolean().default(true), outbound: z.boolean().default(true) })
    .default({ inbound: true, outbound: true }),
  /** Issue `mcp-session-id` on `initialize` in the stateless transport (ADR-016 §10). */
  issueSessionId: z.boolean().default(true),
  /** Price of model input tokens, to turn estimated savings into money (FinOps). */
  pricing: z
    .object({
      currency: z.string().regex(/^[A-Z]{3}$/).default('BRL'),
      inputPerMTok: z.number().min(0).max(10_000).default(15),
    })
    .default({ currency: 'BRL', inputPerMTok: 15 }),
  /** LGPD subject index (ADR-017): detectors fingerprinted per call. */
  subjectIndex: z
    .object({
      enabled: z.boolean().default(true),
      detectors: z.array(z.string().max(40)).max(20).default(['cpf', 'cnpj', 'pis', 'email']),
      maxPerCall: z.number().int().min(1).max(1000).default(200),
    })
    .default({ enabled: true, detectors: ['cpf', 'cnpj', 'pis', 'email'], maxPerCall: 200 }),
  /** Where the `report_outcome` meta-tool is advertised. */
  outcomeTool: z.enum(['off', 'omni', 'all']).default('omni'),
});

export type ObservabilitySettings = z.output<typeof observabilitySettingsSchema>;

export function readObservabilitySettings(settings: unknown): ObservabilitySettings {
  const parsed = observabilitySettingsSchema.safeParse((settings as { observability?: unknown } | null)?.observability ?? {});
  return parsed.success ? parsed.data : observabilitySettingsSchema.parse({});
}

// ---------------------------------------------------------------- tool router (F19, ADR-025)

const routerTimeout = (ms: number) => z.number().int().min(100).max(5000).default(ms);
const probability = (p: number) => z.number().min(0).max(1).default(p);

const routerRerankSchema = z.object({
  enabled: z.boolean().default(true),
  /** Search results the decision model chooses from (`search_tools` returns at most `limit`). */
  candidates: z.number().int().min(5).max(50).default(20),
  minConfidence: probability(0.35),
  timeoutMs: routerTimeout(1500),
});

const routerShortlistSchema = z.object({
  enabled: z.boolean().default(false),
  /** `namespace`: choose tool groups (tag or name prefix); `tool`: choose among search candidates. */
  granularity: z.enum(['namespace', 'tool']).default('namespace'),
  candidates: z.number().int().min(10).max(100).default(50),
  minConfidence: probability(0.35),
  mass: z.number().min(0.5).max(1).default(0.9),
  maxNamespaces: z.number().int().min(1).max(10).default(3),
  minTools: z.number().int().min(1).max(50).default(5),
  maxTools: z.number().int().min(1).max(200).default(30),
  timeoutMs: routerTimeout(2000),
});

const routerGateSchema = z.object({
  enabled: z.boolean().default(false),
  scope: z.enum(['destructive', 'non-readonly', 'all']).default('non-readonly'),
  /** `redacted`: PII-redacted argument values; `none`: argument names only. */
  argsMode: z.enum(['none', 'redacted']).default('redacted'),
  confirmAt: probability(0.5),
  denyAt: probability(0.9),
  /** Provider error or timeout. `allow` because policy already authorized the call. */
  onError: z.enum(['allow', 'deny']).default('allow'),
  /** A "confirm" outcome when no human confirmation (ADR-022) is possible. */
  onConfirmWithoutUi: z.enum(['deny', 'allow']).default('deny'),
  timeoutMs: routerTimeout(1500),
});

/**
 * Decision-model tool router. Off by default; while off (here, per point or by the platform
 * switch), the data plane behaves exactly as without the router.
 */
export const toolRouterSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Decisions per tenant per minute; above it the router falls back (cost guard). */
    maxDecisionsPerMinute: z.number().int().min(1).max(100_000).default(600),
    /** Cache of rerank/shortlist decisions; 0 disables it. */
    cacheTtlSeconds: z.number().int().min(0).max(86_400).default(600),
    rerank: routerRerankSchema.default(() => routerRerankSchema.parse({})),
    shortlist: routerShortlistSchema.default(() => routerShortlistSchema.parse({})),
    gate: routerGateSchema.default(() => routerGateSchema.parse({})),
  })
  .refine((s) => s.gate.confirmAt <= s.gate.denyAt, { path: ['gate', 'confirmAt'], message: 'confirmAt must be <= denyAt' })
  .refine((s) => s.shortlist.minTools <= s.shortlist.maxTools, { path: ['shortlist', 'minTools'], message: 'minTools must be <= maxTools' });

export type ToolRouterSettings = z.output<typeof toolRouterSettingsSchema>;

/** Invalid settings read as the defaults, which keep the router off. */
export function readToolRouterSettings(settings: unknown): ToolRouterSettings {
  const parsed = toolRouterSettingsSchema.safeParse((settings as { toolRouter?: unknown } | null)?.toolRouter ?? {});
  return parsed.success ? parsed.data : toolRouterSettingsSchema.parse({});
}

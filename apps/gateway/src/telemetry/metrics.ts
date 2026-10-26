import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/** Data plane Prometheus metrics (F9.2). Own registry (no global state). */
export class Metrics {
  readonly registry = new Registry();
  readonly toolCallDuration: Histogram<'tenant' | 'tool' | 'decision'>;
  readonly toolCalls: Counter<'tenant' | 'tool' | 'decision'>;
  readonly upstreamRequests: Counter<'tenant' | 'source' | 'status_class'>;
  readonly upstreamDuration: Histogram<'tenant' | 'source'>;
  readonly projectionBytesSaved: Counter<'tenant' | 'tool'>;
  readonly artifactBytes: Counter<'tenant' | 'tool'>;
  readonly redactions: Counter<'tenant' | 'detector'>;
  readonly stageDuration: Histogram<'tenant' | 'stage'>;
  readonly gatewayOverhead: Histogram<'tenant'>;
  readonly callErrors: Counter<'tenant' | 'stage'>;
  readonly tokensSaved: Counter<'tenant' | 'mechanism'>;
  readonly circuitOpen: Gauge<'tenant' | 'source'>;
  readonly routerDecisions: Counter<'tenant' | 'point' | 'provider' | 'decision' | 'reason'>;
  readonly routerDuration: Histogram<'tenant' | 'point' | 'provider'>;
  readonly callEventsWritten: Counter;
  readonly callEventsDropped: Counter<'reason'>;
  readonly callEventsBuffer: Gauge;
  readonly callEventsFlushDuration: Histogram;

  constructor(opts: { defaultMetrics?: boolean } = {}) {
    if (opts.defaultMetrics) collectDefaultMetrics({ register: this.registry, prefix: 'mcp_gateway_' });
    const r = [this.registry];
    this.toolCallDuration = new Histogram({
      name: 'mcp_tool_call_duration_seconds',
      help: 'Tool call latency (full pipeline)',
      labelNames: ['tenant', 'tool', 'decision'],
      buckets: LATENCY_BUCKETS,
      registers: r,
    });
    this.toolCalls = new Counter({ name: 'mcp_tool_calls_total', help: 'Tool calls by decision', labelNames: ['tenant', 'tool', 'decision'], registers: r });
    this.upstreamRequests = new Counter({
      name: 'mcp_upstream_requests_total',
      help: 'Upstream requests by status class (2xx, 4xx, 5xx, error)',
      labelNames: ['tenant', 'source', 'status_class'],
      registers: r,
    });
    this.upstreamDuration = new Histogram({
      name: 'mcp_upstream_duration_seconds',
      help: 'Upstream latency',
      labelNames: ['tenant', 'source'],
      buckets: LATENCY_BUCKETS,
      registers: r,
    });
    this.projectionBytesSaved = new Counter({
      name: 'mcp_projection_bytes_saved_total',
      help: 'Bytes saved by projection',
      labelNames: ['tenant', 'tool'],
      registers: r,
    });
    this.artifactBytes = new Counter({
      name: 'mcp_artifact_offloaded_bytes_total',
      help: 'Bytes offloaded to artifacts (out of the model context)',
      labelNames: ['tenant', 'tool'],
      registers: r,
    });
    this.redactions = new Counter({ name: 'mcp_redactions_total', help: 'PII redacted by detector', labelNames: ['tenant', 'detector'], registers: r });
    // SRE view (F15.10): where the time goes, what the gateway itself adds, and what it saves
    this.stageDuration = new Histogram({
      name: 'mcp_call_stage_duration_seconds',
      help: 'Duration of each pipeline stage (authz, validation, pii, upstream, projection, artifact)',
      labelNames: ['tenant', 'stage'],
      buckets: LATENCY_BUCKETS,
      registers: r,
    });
    this.gatewayOverhead = new Histogram({
      name: 'mcp_gateway_overhead_seconds',
      help: 'Gateway overhead per tool call: total latency minus the upstream share',
      labelNames: ['tenant'],
      buckets: LATENCY_BUCKETS,
      registers: r,
    });
    this.callErrors = new Counter({
      name: 'mcp_call_errors_total',
      help: 'Failed tool calls by pipeline stage (authz, validation, rate_limit, circuit, upstream, internal...)',
      labelNames: ['tenant', 'stage'],
      registers: r,
    });
    this.tokensSaved = new Counter({
      name: 'mcp_tokens_saved_total',
      help: 'Estimated model-context tokens saved, by mechanism (projection, artifact, omni, shortlist)',
      labelNames: ['tenant', 'mechanism'],
      registers: r,
    });
    this.circuitOpen = new Gauge({
      name: 'mcp_circuit_open',
      help: 'Circuit breaker state per source in this process (1 = open)',
      labelNames: ['tenant', 'source'],
      registers: r,
    });
    // tool router (F19, ADR-025)
    this.routerDecisions = new Counter({
      name: 'mcp_router_decisions_total',
      help: 'Tool router decisions by hook point, provider, decision and reason',
      labelNames: ['tenant', 'point', 'provider', 'decision', 'reason'],
      registers: r,
    });
    this.routerDuration = new Histogram({
      name: 'mcp_router_duration_seconds',
      help: 'Time spent in the tool router per hook point (provider call, cache, fallback)',
      labelNames: ['tenant', 'point', 'provider'],
      buckets: LATENCY_BUCKETS,
      registers: r,
    });
    // call event sink (F15.6)
    this.callEventsWritten = new Counter({ name: 'mcp_call_events_written_total', help: 'Call events written to the analytics store', registers: r });
    this.callEventsDropped = new Counter({
      name: 'mcp_call_events_dropped_total',
      help: 'Call events dropped (buffer_full, flush_error, closed)',
      labelNames: ['reason'],
      registers: r,
    });
    this.callEventsBuffer = new Gauge({ name: 'mcp_call_events_buffer_size', help: 'Call events waiting to be flushed', registers: r });
    this.callEventsFlushDuration = new Histogram({
      name: 'mcp_call_events_flush_duration_seconds',
      help: 'Duration of a call event batch flush',
      buckets: LATENCY_BUCKETS,
      registers: r,
    });
  }

  async render(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }
}

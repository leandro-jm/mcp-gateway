import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, startInfra, type Harness, type Infra } from './harness';
import { mcpClient, seedRhTenant, type SeededTenant } from './seed';

describe('metrics and traces (F9.2)', () => {
  let h: Harness;
  let up: FakeUpstream;
  let seeded: SeededTenant;
  let client: Client;
  let base: string;
  const exporter = new InMemorySpanExporter();

  beforeAll(async () => {
    h = await startHarness({ spanProcessors: [new SimpleSpanProcessor(exporter)], env: { METRICS_TOKEN: 'metrics-secret' } });
    up = await startFakeUpstream();
    seeded = await seedRhTenant(h, up);
    await h.services.repos.projections.upsert(seeded.tenantId, seeded.tools.rh_colaboradores_list!, { include: ['$.items[*].id', '$.total'] });
    await h.services.registry.invalidate(seeded.tenantId);
    base = await h.app.listen({ port: 0, host: '127.0.0.1' });
    client = await mcpClient(base, await h.token({ tenant: 'acme' }));
  });
  afterAll(async () => {
    await client?.close();
    await h?.teardown();
    await up?.close();
  });

  it('one span per call with children authz → upstream → redaction → projection; trace id in the audit', async () => {
    exporter.reset();
    await client.callTool({ name: 'rh_colaboradores_list', arguments: { size: 20 } });
    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === 'tools/call rh_colaboradores_list')!;
    expect(root.attributes).toMatchObject({ 'mcp.tenant': 'acme', 'mcp.tool': 'rh_colaboradores_list', 'mcp.decision': 'allow', 'http.response.status_code': 200 });
    const children = spans.filter((s) => s.parentSpanContext?.spanId === root.spanContext().spanId).map((s) => s.name);
    expect(children).toEqual(expect.arrayContaining(['authz', 'upstream', 'redaction', 'projection']));
    expect(spans.every((s) => s.spanContext().traceId === root.spanContext().traceId)).toBe(true);
    const upstream = spans.find((s) => s.name === 'upstream')!;
    expect(upstream.attributes).toMatchObject({ 'mcp.source': 'rh', 'http.response.status_code': 200 });
    const [ev] = await h.services.repos.audit.list(seeded.tenantId, { toolId: seeded.tools.rh_colaboradores_list, limit: 1 });
    expect(ev!.traceId).toBe(root.spanContext().traceId);
  });

  const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
  const PARENT = '00f067aa0ba902b7';
  const traceparent = (trace = TRACE, parent = PARENT) => `00-${trace}-${parent}-01`;
  const lastUpstreamHeaders = () => up.requests.at(-1)!.headers as Record<string, string | undefined>;

  it('_meta.traceparent makes the call a child of the agent span and reaches the upstream (F15.3)', async () => {
    exporter.reset();
    const res = await client.callTool({ name: 'rh_colaboradores_list', arguments: { size: 1 }, _meta: { traceparent: traceparent(), baggage: 'cpf=12345678909' } });
    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === 'tools/call rh_colaboradores_list')!;
    expect(root.spanContext().traceId).toBe(TRACE);
    expect(root.parentSpanContext?.spanId).toBe(PARENT);
    expect(root.kind).toBe(1); // SERVER
    expect(root.attributes).toMatchObject({ 'mcp.method.name': 'tools/call', 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'rh_colaboradores_list' });
    const upstream = spans.find((s) => s.name === 'upstream')!;
    expect(upstream.kind).toBe(2); // CLIENT
    expect(upstream.attributes).toMatchObject({ 'http.request.method': 'GET', 'url.template': expect.stringMatching(/^\//), 'server.address': '127.0.0.1' });
    expect(Object.values(upstream.attributes).some((v) => String(v).includes('://'))).toBe(false);
    expect(lastUpstreamHeaders().traceparent).toBe(`00-${TRACE}-${upstream.spanContext().spanId}-01`);
    expect(lastUpstreamHeaders().baggage).toBeUndefined();
    const callId = (res._meta as Record<string, string>)['io.github.leandro-jm.mcp-gateway/call-id'];
    expect(callId).toMatch(/^[0-9a-f-]{8}-[0-9a-f]{4}-7/);
    expect(root.attributes['gen_ai.tool.call.id']).toBe(callId);
  });

  it('the HTTP traceparent header is used when _meta has none; _meta wins over it', async () => {
    const other = '11111111111111111111111111111111';
    const c = new Client({ name: 'trace-header', version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${await h.token({ tenant: 'acme' })}`, traceparent: traceparent(other) } },
    }));
    try {
      exporter.reset();
      await c.callTool({ name: 'rh_colaboradores_list', arguments: { size: 1 } });
      expect(exporter.getFinishedSpans().find((s) => s.name.startsWith('tools/call'))!.spanContext().traceId).toBe(other);
      exporter.reset();
      await c.callTool({ name: 'rh_colaboradores_list', arguments: { size: 1 }, _meta: { traceparent: traceparent() } });
      expect(exporter.getFinishedSpans().find((s) => s.name.startsWith('tools/call'))!.spanContext().traceId).toBe(TRACE);
    } finally {
      await c.close();
    }
  });

  it('invalid traceparent is ignored and the tenant can opt out of propagation', async () => {
    exporter.reset();
    await client.callTool({ name: 'rh_colaboradores_list', arguments: { size: 1 }, _meta: { traceparent: '00-zz-yy-01' } });
    expect(exporter.getFinishedSpans().find((s) => s.name.startsWith('tools/call'))!.parentSpanContext).toBeUndefined();

    await h.services.repos.tenants.update(seeded.tenantId, { settings: { observability: { tracePropagation: { inbound: false, outbound: false } } } });
    await h.services.registry.invalidate(seeded.tenantId);
    try {
      exporter.reset();
      await client.callTool({ name: 'rh_colaboradores_list', arguments: { size: 1 }, _meta: { traceparent: traceparent() } });
      expect(exporter.getFinishedSpans().find((s) => s.name.startsWith('tools/call'))!.spanContext().traceId).not.toBe(TRACE);
      expect(lastUpstreamHeaders().traceparent).toBeUndefined();
    } finally {
      await h.services.repos.tenants.update(seeded.tenantId, { settings: {} });
      await h.services.registry.invalidate(seeded.tenantId);
    }
  });

  it('errors mark the span and the metrics by status class', async () => {
    exporter.reset();
    await client.callTool({ name: 'rh_colaborador_get', arguments: { id: 'x' } });
    const root = exporter.getFinishedSpans().find((s) => s.name === 'tools/call rh_colaborador_get')!;
    expect(root.attributes['mcp.decision']).toBe('error');
    expect(root.status.code).toBe(2);
  });

  it('/metrics exposes latency (p50/p95/p99 histogram), errors per source, bytes saved and redactions per detector', async () => {
    const denied = await h.app.inject({ method: 'GET', url: '/metrics' });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toEqual({ error: 'UNAUTHORIZED', message: 'invalid metrics token' });
    expect((await h.app.inject({ method: 'GET', url: '/metrics', headers: { 'accept-language': 'es' } })).json().message).toBe('token de métricas inválido');
    const res = await h.app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer metrics-secret' } });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).toMatch(/mcp_tool_call_duration_seconds_bucket\{le="0\.1",tenant="acme",tool="rh_colaboradores_list",decision="allow"\} \d/);
    expect(body).toMatch(/mcp_tool_calls_total\{tenant="acme",tool="rh_colaborador_get",decision="error"\} 1/);
    expect(body).toMatch(/mcp_upstream_requests_total\{tenant="acme",source="rh",status_class="4xx"\} 1/);
    expect(body).toMatch(/mcp_upstream_requests_total\{tenant="acme",source="rh",status_class="2xx"\} \d+/);
    expect(body).toMatch(/mcp_projection_bytes_saved_total\{tenant="acme",tool="rh_colaboradores_list"\} \d{3,}/);
    expect(body).toMatch(/mcp_redactions_total\{tenant="acme",detector="cpf"\} \d+/);
    // F15.10: stage latency, gateway overhead, errors per stage and tokens saved
    expect(body).toMatch(/mcp_call_stage_duration_seconds_count\{tenant="acme",stage="upstream"\} \d+/);
    expect(body).toMatch(/mcp_gateway_overhead_seconds_count\{tenant="acme"\} \d+/);
    expect(body).toMatch(/mcp_call_errors_total\{tenant="acme",stage="upstream"\} \d+/);
    expect(body).toMatch(/mcp_tokens_saved_total\{tenant="acme",mechanism="projection"\} \d+/);
    expect(body).toMatch(/mcp_circuit_open\{tenant="acme",source="rh"\} 0/);
  });
});

describe('health and readiness (F9.3)', () => {
  let infra: Infra;
  let h: Harness;

  beforeAll(async () => {
    infra = await startInfra({ minio: true });
    h = await startHarness({ infra });
  });
  afterAll(async () => {
    await h?.teardown();
    await infra?.stop();
  });

  it('readiness is green with every dependency and fails when one goes down', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ status: 'ok' });
    const ok = await h.app.inject({ method: 'GET', url: '/readyz' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ status: 'ready', checks: { postgres: 'ok', redis: 'ok', s3: 'ok' } });

    await infra.minio!.stop();
    const noS3 = await h.app.inject({ method: 'GET', url: '/readyz' });
    expect(noS3.statusCode).toBe(503);
    expect(noS3.json().checks.s3).toMatch(/^fail/);
    expect(noS3.json().checks.postgres).toBe('ok');
    // healthz (liveness) stays ok: the process is alive
    expect((await h.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });
});

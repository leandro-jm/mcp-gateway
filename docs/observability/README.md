# Observabilidade

Cada chamada gera um **evento largo** (`CallEvent`, ADR-016). Auditoria, métricas, atributos de span e a tabela `call_events` derivam dele. O uso das visões, do explorador, da LGPD, das sessões e do MCP de observabilidade está no [guia](./guia.md).

## Evento de chamada (`call_events`)
- Uma linha por chamada: `tools/call`, step de composta (`composite_step`), meta-tool do Omni (`meta`), `tools/list` (`list`) e artifact tools (`artifact`).
- Colunas:
  - identidade: tenant, subject sanitizado, client, agente, sessão, virtual server, endpoint;
  - tool: nome, versão, kind, source;
  - decisão: decision, regra de política, motivo, trace da política só em deny;
  - erro: código e etapa;
  - dados: redactions por detector, bytes antes e depois da projeção, artefato;
  - latência por etapa (`authz_ms`, `validation_ms`, `pii_ms`, `upstream_ms`, `projection_ms`, `artifact_ms`) e `overhead_ms` (latência total menos a do upstream);
  - tokens estimados (bytes/4): resposta, bruto, economizados por projeção e por artefato, catálogo.
- Campos reservados, sempre nulos por enquanto: `plugins`, `gate`, `taint`, `pinned_version`.
- Nunca guarda payload, texto de busca nem texto livre. A busca do Omni guarda só o hash da query e os nomes devolvidos.
- Particionada por dia (`call_events_pYYYYMMDD`). Partições são criadas 3 dias à frente pelo job de manutenção, e as mais velhas que `CALL_EVENTS_RETENTION_DAYS` (padrão 30) são removidas.
- Escrita em lote, sem bloquear a chamada:
  - flush a cada `CALL_EVENTS_FLUSH_MS` (1 s) ou `CALL_EVENTS_BATCH_SIZE` (500) eventos;
  - buffer limitado a `CALL_EVENTS_BUFFER_MAX` (20 000);
  - com o buffer cheio, o evento é descartado e conta em `mcp_call_events_dropped_total`;
  - a auditoria continua síncrona.
- Rollups por hora (`call_rollups_hourly`) e por dia e sujeito (`usage_rollups_daily`), recalculados pelo job de manutenção, alimentam os dashboards e a API de analytics. Retenção: `CALL_ROLLUPS_RETENTION_DAYS` (400).
- Consulta: `POST /admin/v1/analytics/query`, com uma DSL tipada (`metric`, `groupBy`, `filters`, `range`). Exige `gateway-admin` ou `analytics-reader`.

## Métricas (Prometheus)
`GET /metrics` no gateway. É protegido por `Authorization: Bearer $METRICS_TOKEN` quando a variável está definida.

| Métrica | Tipo | Labels | Uso |
|---|---|---|---|
| `mcp_tool_call_duration_seconds` | histograma | tenant, tool, decision | latência p50/p95/p99 por tool |
| `mcp_tool_calls_total` | contador | tenant, tool, decision (`allow`/`deny`/`error`) | volume, erros, negações |
| `mcp_call_stage_duration_seconds` | histograma | tenant, stage | tempo por etapa do pipeline |
| `mcp_gateway_overhead_seconds` | histograma | tenant | overhead do gateway: o que ele soma à latência do upstream |
| `mcp_call_errors_total` | contador | tenant, stage | erros por etapa (`authz`, `validation`, `rate_limit`, `circuit`, `upstream`, `internal`…) |
| `mcp_upstream_requests_total` | contador | tenant, source, status_class (`2xx`/`4xx`/`5xx`/`error`) | taxa de erro por source |
| `mcp_upstream_duration_seconds` | histograma | tenant, source | latência do upstream |
| `mcp_circuit_open` | gauge | tenant, source | circuit breaker aberto neste processo |
| `mcp_projection_bytes_saved_total` | contador | tenant, tool | bytes economizados pela projeção (F6) |
| `mcp_artifact_offloaded_bytes_total` | contador | tenant, tool | bytes desviados para artefatos (F8) |
| `mcp_tokens_saved_total` | contador | tenant, mechanism (`projection`/`artifact`/`omni`) | tokens de contexto economizados (estimativa) |
| `mcp_redactions_total` | contador | tenant, detector | PII redigida por detector (F5) |
| `mcp_call_events_written_total` / `_dropped_total` / `_buffer_size` | contador / gauge | reason | saúde do pipeline de analytics |

O dashboard de exemplo está em [`grafana-dashboard.json`](./grafana-dashboard.json). Para usar, importe no Grafana e escolha a datasource Prometheus.

### Alertas e SLOs
O arquivo [`prometheus-rules.yml`](./prometheus-rules.yml) traz dois SLOs, ambos com alertas de burn rate em várias janelas (página em 14,4x por 1h/5m; ticket em 6x por 6h/30m):
- **Disponibilidade:** 99,5% das chamadas sem erro causado pelo gateway.
- **Overhead:** 95% das chamadas com overhead de até 25 ms.

O arquivo também traz alertas de circuit breaker aberto, de erro no upstream e de eventos de analytics descartados. Para usar, inclua-o em `rule_files` do Prometheus.

## Traces (OpenTelemetry)
Defina `OTEL_EXPORTER_OTLP_ENDPOINT` (por exemplo, `http://otel-collector:4318`). Cada `tools/call` gera:

```
tools/call {tool}        SERVER (gen_ai.*, mcp.*, mcp_gateway.*)
├─ authz
├─ upstream              CLIENT (http.request.method, url.template, server.address, status, resend_count) — ou composite.step × N
├─ redaction             (redactions)
├─ projection            (bytes antes/depois)
└─ artifact.offload      (bytes do artefato)
```

- **Convenções semânticas.** Os atributos seguem as convenções GenAI/MCP do OpenTelemetry, que ainda estão em fase *incubating*:
  - `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id`;
  - `mcp.method.name`, `mcp.session.id`, `error.type`.
  - Os atributos próprios do gateway ficam em `mcp_gateway.*`.
  - `mcp.tenant`, `mcp.tool` e `mcp.decision` continuam sendo emitidos por uma fase, marcados como deprecated.
- **Propagação na entrada.** O gateway aceita o contexto do agente por `params._meta.traceparent`, que tem prioridade, ou pelo header HTTP `traceparent`. Com isso, o trace do agente, o do gateway e o do upstream formam uma jornada só.
- **Propagação na saída.** O gateway envia `traceparent` ao upstream.
- **O que é ignorado.** `baggage` nunca é lido. Valores inválidos são descartados.
- **Opt-out por tenant.** `settings.observability.tracePropagation = { inbound, outbound }`.
- **Ligações.** O `trace_id` vai para `audit_events.trace_id` e para `call_events.trace_id`. O id da chamada volta ao cliente em `_meta["io.github.leandro-jm.mcp-gateway/call-id"]`.

## Sessão e agente
- No `initialize`, o gateway emite `mcp-session-id` (`mgs1_…`) com o `clientInfo` declarado pelo cliente, mesmo no transporte stateless.
- Clientes que seguem a spec devolvem o header. Com ele, o gateway agrupa as chamadas por sessão (trajetórias) e registra o nome e a versão do agente.
- O nome do agente é informativo e nunca entra em autorização.
- Toggle por tenant: `settings.observability.issueSessionId`.

## Saúde
- `GET /healthz`: liveness. O processo está vivo.
- `GET /readyz`: readiness. Checa Postgres, Redis e S3 (quando os artefatos estão habilitados). Responde `503` com o detalhe de cada check quando algo falha.

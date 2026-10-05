# ADR-016: Observabilidade de agentes (evento largo por chamada)

- Status: aceito
- Data: 2026-10-04

## Contexto
A F9 entregou `audit_events`, métricas prom-client e spans OTel. Cada saída é montada por conta própria dentro do `ToolExecutor`, e muita coisa já calculada se perde no caminho:
- o `ruleId` da decisão allow e o `trace` da política;
- a contagem do detokenize;
- `durationMs` e `attempts` do upstream;
- os bytes antes e depois da projeção.

Também faltam peças:
- propagação de trace (nem `_meta.traceparent`, nem header, nem envio ao upstream);
- identidade de sessão e de agente no transporte stateless;
- estimativa de tokens;
- registro das meta-tools do Omni;
- analytics por público e por sessão.

A F15 transforma o gateway na fonte de observabilidade dos agentes, para SRE, owner de tool, segurança/compliance e FinOps, além do analytics de trajetórias. O ClickHouse seria o armazenamento natural para analytics em volume, mas acrescenta um serviço à VPS. Nesta fase, o volume esperado cabe no Postgres.

## Decisão

1. **Um `CallEvent` largo por chamada.**
   - O tipo (versão `v: 1`) vive no pacote puro `packages/call-analytics`.
   - O executor monta o evento com um `CallRecorder`, que cronometra as etapas e coleta decisões, contagens, bytes e tokens.
   - No `finally`, as demais saídas derivam do evento:
     - a linha de auditoria (`toAuditInput`), que continua síncrona;
     - as métricas (`recordCallMetrics`);
     - os atributos do span (`toSpanAttributes`);
     - `sink.write(ev)`, que não bloqueia.
   - Kinds de evento:
     - `tool`: chamada normal;
     - `composite_step`: com `parent_call_id`;
     - `meta`: `search_tools`/`get_tool_schema`, guardando os nomes devolvidos e o hash da query, nunca o texto;
     - `list`: `tools/list`, com `catalog_tokens`;
     - `artifact`;
     - `outcome`.
   - O `call_id` passa a ser UUIDv7. O tempo embutido no id permite podar partições em `explain_call`.
2. **Campos reservados.** `plugins`, `gate` (`{required, outcome, reason}`), `taint` (`{origin, destination}`) e `pinned_version` existem no tipo e na tabela como nulos. A F15 não os preenche; eles ficam para os recursos que ainda não existem (plugins, confirm gate, fluxos entre servidores, pinning).
3. **Postgres primeiro, atrás de interfaces.**
   - `CallEventSink` (escrita) e `AnalyticsStore` (leitura). Um adaptador ClickHouse pode substituir ambos depois, sem mexer no executor nem nas rotas.
   - Sem OTel Collector nesta fase. As métricas e os traces continuam saindo direto do gateway (prom-client e OTLP).
4. **`call_events`.**
   - Particionada por dia (`call_events_pYYYYMMDD`), com partição DEFAULT, 3 partições criadas à frente e retenção `CALL_EVENTS_RETENTION_DAYS` (30).
   - PK `(ts, call_id)`.
   - Tudo que é filtrado, agrupado ou somado é coluna tipada. Vão para jsonb: `redactions_by_detector`, `policy_trace` (só em deny), `meta` e os campos reservados.
   - `overhead_ms` é uma coluna gerada: `latency_ms − upstream_ms`. É a métrica que mostra se o gateway atrapalha ou não.
5. **`audit_events` continua sendo o registro de compliance**: síncrono, retenção de 12 meses, mesmo formato. Passa a guardar também o `ruleId` das decisões allow.
6. **Writer em lote.** `BatchingCallEventSink`:
   - Buffer em memória, com flush a cada `CALL_EVENTS_FLUSH_MS` (1 s) ou `CALL_EVENTS_BATCH_SIZE` (500) eventos. Um flush por vez, num insert multi-linha.
   - Teto de `CALL_EVENTS_BUFFER_MAX` (20 000). Com o buffer cheio, o evento é descartado e conta em `mcp_call_events_dropped_total{reason}`. Um flush que falha é tentado de novo uma vez e depois descartado.
   - `close()` faz flush com orçamento de 5 s.
   - Perder analytics num pico é aceitável. Perder auditoria não é, e por isso ela segue síncrona.
7. **Rollups.**
   - `call_rollups_hourly` e `usage_rollups_daily` (chargeback por subject, client e agente).
   - Cada bucket guarda somas e um histograma `int[]` com os buckets de latência do Prometheus, de onde saem os percentis estimados.
   - São mantidos pelo `runMaintenance` com `pg_try_advisory_xact_lock` e watermark: recomputa cada hora fechada desde o watermark e a hora corrente parcial. É idempotente (delete + insert por bucket).
   - Dashboards só leem rollups. O explorador de chamadas e as trajetórias leem os eventos brutos.
8. **Propagação de trace.**
   - `W3CTraceContextPropagator` de `@opentelemetry/core`, instanciado (sem registro global) e sem AsyncLocalStorage, porque o código já passa o `Context` explicitamente.
   - Precedência na entrada:
     1. `params._meta.traceparent`/`tracestate`, como recomendam as convenções MCP do OTel;
     2. o header HTTP `traceparent`;
     3. uma raiz nova.
   - `baggage` é ignorado porque pode carregar PII.
   - O span `upstream` vira `CLIENT` e o `RestAdapter` envia `traceparent` ao upstream. O header do gateway prevalece sobre qualquer header vindo dos argumentos.
   - Entrada e saída têm opt-out por tenant (`settings.observability.tracePropagation`).
9. **Convenções semânticas GenAI/MCP do OTel** (ainda incubating).
   - Atributos: `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `mcp.method.name`, `mcp.session.id` (hash), `mcp.protocol.version`, `jsonrpc.request.id`, `error.type`.
   - No span de upstream: `http.request.method`, `url.template` (nunca a URL resolvida, que pode conter identificadores), `server.address`, `http.response.status_code`, `http.request.resend_count`.
   - Atributos próprios do gateway vão para `mcp_gateway.*`.
   - `mcp.tenant`, `mcp.tool` e `mcp.decision` continuam sendo emitidos por uma fase, marcados como deprecated, para não quebrar dashboards existentes.
   - Os nomes ficam centralizados em `semconv.ts`.
   - O `callId` volta ao cliente em `_meta["io.github.leandro-jm.mcp-gateway/call-id"]` (namespace renomeado no ADR-019).
10. **Sessão e agente no transporte stateless.**
    - No `initialize`, o gateway emite `mcp-session-id = mgs1_<base64url({sid, cn, cv})>`, em que `cn`/`cv` são o `clientInfo` declarado pelo cliente.
    - Clientes que seguem a spec devolvem o header em toda requisição. O gateway então sabe a sessão e o agente sem guardar estado.
    - O id não é assinado, porque o `clientInfo` já é autodeclarado. O `sessionKeyOf` vincula o id a `tenant:sub`, então reaproveitar o id de outra pessoa não alcança nada.
    - Precedência da `session_source`: header, depois sessão do Omni dinâmico, depois o principal.
    - Toggle por tenant: `settings.observability.issueSessionId` (default ligado).
    - Consequência no ADR-010: artefatos de clientes que devolvem o header passam a ficar presos à sessão.
11. **Estimativa de tokens.**
    - `estimateTokens = ceil(bytes / 4)`, sobre bytes que o pipeline já mede, sem `JSON.stringify` extra.
    - É uma estimativa para comparação e FinOps, não serve para cobrança.
    - Economia por mecanismo:
      - projeção: bytes antes − bytes depois;
      - artefato: bytes do artefato − bytes do resumo;
      - Omni: tokens do catálogo completo − tokens do catálogo de meta-tools.
    - O preço é por tenant (`settings.observability.pricing`).
12. **Analytics consultável.**
    - Uma DSL tipada (`AnalyticsQuery`): métrica e dimensões de um enum, no máximo 2 `groupBy`, filtros tipados, janela `last` ou `from/to` de até 90 dias, `limit` ≤ 100.
    - Compilada para SQL por whitelist, com parâmetros em bind. **Nunca aceita SQL.**
    - Exposta em `POST /admin/v1/analytics/query` e no MCP de observabilidade.
13. **MCP de observabilidade.**
    - `POST /mcp/observability`, stateless. Tools: `analytics_query`, `explain_call` e `top_failing_tools`, todas com `outputSchema` e `structuredContent`.
    - Acesso: `gateway-admin` do tenant ou o papel novo `analytics-reader` (ADR-011).
    - Nunca devolve payload bruto e não oferece a consulta LGPD.
    - As próprias chamadas viram eventos com `endpoint='observability'`.
14. **`report_outcome`.**
    - O cliente informa o desfecho da tarefa (`success | partial | failure | abandoned` + `reason_code` de um enum, sem texto livre).
    - Disponível como meta-tool (`settings.observability.outcomeTool`: `off | omni | all`, default `omni`) e como `POST /v1/outcomes` no data plane.
    - Vinculação: `call_ids` explícitos (mesmo tenant e subject) ou a janela da sessão desde o último outcome (até 50 chamadas e 2 h).
    - Dá taxa de sucesso real por tool e por virtual server.
15. **Analytics de agente.**
    - Algoritmos puros no `call-analytics`: sessionização, loops, thrash, busca seguida de escolha errada, abandono, mineração de sequências e transições.
    - Um job (a cada 15 min, com lock e watermark) grava `agent_findings`, `tool_transitions_daily` e `composite_suggestions`.
    - Uma sugestão aceita vira composta `draft` e `disabled` pelo mesmo caminho do `POST /composites`. Humano no circuito, como no ADR-015.

## Consequências
- O executor tem um ponto único de coleta. Novas dimensões entram no `CallEvent` e aparecem em audit, métricas, spans e analytics sem duplicação.
- A auditoria continua sendo a única escrita síncrona por chamada. Analytics pode perder eventos sob pressão, e isso é visível em `mcp_call_events_dropped_total`.
- O Postgres aguenta o volume de um gateway por VPS. Quando não aguentar, troca-se o `CallEventSink`/`AnalyticsStore` por ClickHouse (tabela MergeTree com o mesmo formato) e os rollups viram materialized views.
- Os nomes das convenções semânticas podem mudar. A mudança fica restrita a `semconv.ts`.
- Clientes MCP que seguem a spec passam a ter sessão (e artefatos por sessão) mesmo no modo stateless.
- Um agente pode mentir no `clientInfo`. O nome do agente é informativo e nunca entra em decisão de autorização.

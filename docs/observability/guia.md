# Guia de observabilidade de agentes (F15)

Este guia mostra como usar o que a F15 entrega: as visões por público, o explorador de chamadas, a captura de debug, o índice de titulares LGPD, as sessões, os insights de agente e o MCP de observabilidade. As decisões estão nos ADR-016, ADR-017 e ADR-018. A parte operacional (métricas, traces, alertas) está no [README](./README.md).

## Quem vê o quê

| Papel | Acesso |
|---|---|
| `gateway-admin` | Tudo, inclusive a consulta LGPD, a captura de debug, o replay e as configurações. |
| `analytics-reader` | Leitura de analytics: visões, explorador sem payload, sessões, insights e o MCP de observabilidade. Não acessa LGPD, captura de debug nem configurações. |
| `tool-owner` | Aba Tools da observabilidade e chamadas das tools do próprio time. Pode aceitar ou descartar sugestões de compostas. |
| `agent` | Nenhuma rota de analytics. |

## Visões por público (Admin UI → Observabilidade)
- **Operação.**
  - O overhead do gateway (latência total menos a do upstream) separado da latência do upstream: é o número que mostra que o gateway não atrapalha.
  - Também: erros do upstream por source, falhas por etapa, chamadas recusadas por circuit breaker e o tempo médio de cada etapa.
- **Tools.**
  - Uso por tool e por agente, erros, retries e erros de validação.
  - Tools habilitadas que ninguém usou no período: são candidatas a desabilitar ou a ganhar uma descrição melhor.
  - O impacto de cada drift na taxa de erro (7 dias antes × depois).
- **Segurança.**
  - Negações por tool e por regra de política, e redactions por tipo de dado.
  - Anomalias de volume: a última hora comparada com a mesma hora nas quatro semanas anteriores, por client e por agente.
  - A consulta LGPD (só admin).
- **FinOps.**
  - Tokens economizados por projeção, artefatos e Omni, convertidos em dinheiro com o preço do tenant (Configurações → Observabilidade).
  - O card "sem o gateway × com o gateway" e o uso por client, agente e usuário (chargeback).
  - Tokens são estimados (bytes ÷ 4): servem para comparar, não para faturar.

Os mesmos números saem da Admin API: `GET /admin/v1/analytics/{sre,tools,security,finops}`. Para qualquer outra pergunta, use `POST /admin/v1/analytics/query`:

```json
{ "metric": "error_rate", "groupBy": ["tool"], "filters": { "agent": "claude-code" }, "range": { "last": "7d" } }
```

- **Métricas:** `calls`, `errors`, `denies`, `error_rate`, latências (média, p50, p95, p99, máxima), `overhead_avg`, `overhead_p95`, médias por etapa, `retries`, `redactions`, tokens, `agents`, `clients` e `success_rate`.
- **Dimensões:** `tool`, `tool_kind`, `source`, `client`, `agent`, `virtual_server`, `endpoint`, `kind`, `decision`, `error_stage`, `error_code`, `hour` e `day`.
- **Limites:** no máximo 2 dimensões e 90 dias. Não há SQL: a consulta usa só a lista fixa acima.

## Explorador de chamadas (Admin UI → Chamadas)
Cada chamada mostra:
- o tempo por etapa;
- a regra de política que decidiu, com o trace das regras numa negação;
- se a política mudou desde então, caso em que a decisão de hoje aparece ao lado;
- as redactions por tipo, quanto a projeção cortou, os tokens, os steps de compostas e o link para o trace.

Da auditoria, o botão **Explicar** abre a chamada.

O id da chamada volta ao agente em `_meta["io.github.leandro-jm.mcp-gateway/call-id"]` e também é usado no `explain_call` e no `report_outcome`.

## Captura de debug e replay (só `gateway-admin`)
1. Habilite no ambiente: `DEBUG_CAPTURE_ENABLED=true`. A captura também exige S3.
2. Em **Chamadas → Capturas de debug**, abra uma captura com motivo, filtro opcional (tool, sujeito), limite de chamadas e duração (até 60 min).
3. As chamadas que casam ficam cifradas no S3 por 24 h. No explorador, **Mostrar bruto × final** exibe o diff.
4. **Repetir com a configuração atual** roda o pipeline de novo sobre a resposta gravada, com as políticas, as regras de PII e a projeção de agora. O upstream não é chamado de novo. O resultado mostra o que mudou em decisão, bytes e redactions, o que serve para testar uma projeção ou uma regra nova com dados reais.

Abrir, parar e visualizar capturas, e repetir chamadas, são ações auditadas.

## Acesso a dados de titular (LGPD)
Em **Observabilidade → Segurança**, informe o identificador (CPF, CNPJ, PIS, e-mail ou telefone). O relatório mostra quais usuários, agentes, clients e tools receberam ou enviaram dados daquela pessoa e quando.

- O valor vira um fingerprint (HMAC por tenant) e nunca é guardado nem logado. A consulta é auditada sem o valor.
- Chamadas que listaram titulares demais (acima do limite por chamada) aparecem à parte, como "podem incluir este titular".
- O índice vive mais que os eventos brutos: `SUBJECT_INDEX_RETENTION_MONTHS`, padrão 12.

API: `POST /admin/v1/lgpd/subject-access` com `{ "detector": "cpf", "value": "…" }`.

## Sessões e insights de agente
- **Sessões.** Cada sessão (clientes que devolvem o `mcp-session-id`) aparece como uma linha do tempo, com uma faixa por tool. É possível avançar passo a passo ou reproduzir a sessão, como num debugger do agente.
- **Insights de agente:**
  - **Padrões:** loop (mesma tool com os mesmos argumentos), vai e volta entre tools sem progresso, busca errada (o agente chamou uma tool que o `search_tools` não devolveu, ou buscou de novo) e abandono (a última chamada de uma tool falhou).
  - **Sugestões:** sequências frequentes ("A → B → C" em várias sessões de usuários diferentes) viram um rascunho de composta. **Criar rascunho** salva a composta desabilitada e a abre no Composer; **Refinar com linguagem natural** leva o pedido para o composer com LLM.
  - **Co-uso:** o grafo de tools usadas uma depois da outra, útil para montar MCP servers.
  - **Resultados:** a taxa de sucesso real por tool e por MCP server, quando os clientes informam o resultado.
- **Atualização:** o job roda a cada 15 minutos. Um admin pode rodá-lo na hora com `POST /admin/v1/agent-insights/refresh`.

## report_outcome
O cliente informa se a tarefa deu certo. Isso dá taxa de sucesso por tool e por MCP server, ou seja, avaliação em produção.

- **Meta-tool `report_outcome`:**
  - Disponível nos endpoints Omni por padrão. Configurações → Observabilidade permite deixá-la em todos os endpoints ou desligá-la.
  - Argumentos: `outcome` (`success`, `partial`, `failure`, `abandoned`), `reason_code` opcional e `call_ids` opcionais.
  - Sem `call_ids`, o resultado vale para as chamadas da sessão desde o último resultado (até 50 chamadas e 2 h).
- **`POST /v1/outcomes`:** a mesma coisa para orquestradores (por exemplo, um framework de agentes), com o token do agente.
- **Sem texto livre:** só os enums, para não guardar PII.

## MCP de observabilidade
`POST /mcp/observability` (papéis `gateway-admin` ou `analytics-reader`) expõe três tools:
- `top_failing_tools`
- `explain_call`
- `analytics_query`

Conecte o Claude e pergunte "por que a tool X falhou mais esta semana?". A configuração do cliente está em [docs/integrations/claude-code.md](../integrations/claude-code.md). As respostas nunca trazem payload.

## Configurações (Configurações → Observabilidade)
- Propagação de trace: entrada (`_meta.traceparent` ou header) e saída (para o upstream).
- Emissão do `mcp-session-id` no `initialize`, que agrupa as chamadas em sessões e identifica o agente.
- Preço por milhão de tokens e a moeda.
- Índice LGPD: ligado ou desligado, os identificadores indexados e o limite por chamada.
- Onde a meta-tool `report_outcome` aparece.

## Quando trocar o Postgres por ClickHouse
Os eventos vão para o Postgres, particionados por dia, e os dashboards leem agregados por hora. Para volumes muito maiores, a troca fica atrás das interfaces `CallEventSink` (escrita) e `AnalyticsStore` (leitura) e não muda a API nem a UI (ADR-016): uma tabela MergeTree com o mesmo formato, com os rollups como materialized views.

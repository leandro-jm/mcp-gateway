# Estudo: roteamento de tools com modelos de decisão (Jev e OpenAI Decisions)

- Data: 2026-10-22
- Decisão resultante: [ADR-025](../decisions/ADR-025-roteador-de-tools-modelos-de-decisao.md)
- Fase do roadmap: F19

## 1. Contexto

O gateway expõe APIs REST como tools MCP. Um tenant típico tem centenas de tools, e expor todas no `tools/list` custa contexto e piora a escolha da tool pelo agente. A Anthropic, por exemplo, relata que a precisão de seleção cai visivelmente a partir de 30–50 tools no contexto.

Hoje o gateway ataca isso de três formas:
- **Virtual servers** (`/mcp/s/:slug`) com um `toolSelector` estático.
- **Omni** (`/mcp/omni`, ADR-009): três meta-tools (`search_tools`, `get_tool_schema`, `call_tool`) com busca FTS no Postgres (estilo BM25, sinônimos e prior de intenção) e, opcionalmente, embeddings fundidos por RRF. O critério da F7.1 é top-3 ≥ 90% em 200 tools sintéticas, e o da F7.2 é usar menos de 15% dos tokens de definição.
- **Política** (default deny): o agente só vê o que pode chamar.

O que falta:
- A busca é lexical/vetorial. Ela acerta o recurso, mas erra a operação quando a consulta é ambígua ("ver as férias da Ana" × "marcar férias da Ana").
- O `tools/list` nativo não tem como usar a intenção do agente: ou mostra tudo, ou o que um virtual server fixou.
- Não há um segundo olhar sobre chamadas de escrita antes do upstream, além da política e da confirmação humana do ADR-022, que exige um cliente com UI.

## 2. O que são modelos de decisão

Em 2026 surgiu uma categoria nova de API: modelos que **não geram texto**. Eles recebem um estado (texto ou JSON) e um conjunto de perguntas tipadas, e devolvem probabilidades calibradas:

| Tipo | Pergunta | Resposta |
|---|---|---|
| `predicate` (OpenAI) / `noul` (Jev) | Sim ou não? | probabilidade de 0 a 1 |
| `choice` | Qual destas opções? | a opção escolhida, a distribuição de probabilidades e a confiança |
| `score` | Em que nível de uma rubrica ordenada? | nível médio ponderado, distribuição e confiança |

Por que isso interessa para roteamento:
- **A saída é sempre do tipo pedido.** Não há JSON quebrado nem nome de tool inventado: a resposta é uma das opções oferecidas.
- **A distribuição permite decidir pelo limiar.** Dá para guardar as opções até somar 90% da massa, ou cair no fallback quando a confiança é baixa.
- **É rápido e barato.** Os fornecedores falam em 70–500 ms e US$ 0,04–0,10 por milhão de tokens de entrada, com a saída de graça.
- **Não gera argumentos.** O agente continua preenchendo a chamada; o modelo de decisão só escolhe ou filtra.

Uma ressalva repetida pelos revisores: "não alucina tipo" não quer dizer "não erra". O modelo pode estar errado com muita confiança. Os limiares devem vir de dados rotulados, e a confiança é evidência, nunca autorização.

## 3. Os dois provedores

| | OpenAI Decisions API | TypeSafe Jev |
|---|---|---|
| Endpoint | `POST https://api.openai.com/v1/decisions` | `POST https://api.typesafe.ai/v1/systemone` |
| Modelo | `gpt-6-luna` | `jev-latest`, `jev-1.13.0` |
| Status (out/2026) | beta pública desde 2026-10-06 (apresentada no DevDay de 2026-09-29) | lançado em ~2026-09-15; acesso por waitlist |
| Formato das perguntas | array `questions[]` com `name` | mapa `questions{<id>}` |
| Tipos | `predicate`, `choice` (`choices[{value, description}]`), `score` (`levels[{label, description}]`) | `noul`, `choice` (`criteria{opção: descrição}`), `score` (`criteria` ordenado) |
| Limite de opções | não documentado | 255 por pergunta |
| Contexto | ~1M tokens (relatado por gateways) | 32K tokens |
| Recusa | `refusal` por pergunta, sem afetar as demais | não documentada |
| Preço | US$ 0,10 / 1M de entrada; saída e cache grátis | US$ 0,042 / 1M de entrada (preço de lançamento) |
| Dados | ZDR, HIPAA, residência EUA/UE | terceiro novo, sem DPA público conhecido |

O mapeamento entre os dois formatos é mecânico:

| Jev | OpenAI |
|---|---|
| `state` | `input` |
| `questions` (mapa) | `questions` (array; a chave vira `name`) |
| `noul` | `predicate` |
| `criteria` de `choice` | `choices` |
| `criteria` de `score` | `levels` |
| `answers.<id>` | `answers[]` com `name` |

Gateways como o Vercel AI Gateway e o llmgateway.io já servem os dois atrás do mesmo formato `/v1/decisions`. Isso confirma que um **modelo neutro com um adaptador por provedor** é a abstração certa.

A própria OpenAI diz para que a API **não** serve: gerar JSON (para isso existe Structured Outputs) e chamar tools com argumentos (para isso existe function calling). As boas práticas do guia são:
- opções com descrições bem distintas entre si;
- uma opção "outro" como saída;
- perguntas independentes no mesmo request, e perguntas dependentes encadeadas;
- limiares calibrados com dados rotulados.

## 4. Como o mercado faz roteamento de tools

| Abordagem | Como escolhe | Observações |
|---|---|---|
| OpenAI `tool_search` (Responses API) | `defer_loading: true` nas functions ou no servidor MCP; busca hospedada, ou pelo cliente (`execution: "client"`) | Recomenda menos de 10 functions por namespace; trocar o conjunto carregado quebra o cache |
| Anthropic tool search tool | Busca por regex ou BM25 com `defer_loading`; uma tool customizada pode devolver `tool_reference` (embeddings ou modelo externo) | Até 10.000 tools adiadas; mais de 85% de economia de contexto |
| RAG-MCP (arXiv 2505.03275) | Recuperação por embeddings das descrições antes da chamada ao LLM | Precisão de seleção sobe de 13,6% para 43,1%; degrada com o tamanho do registro |
| LiteLLM | Filtro semântico (embeddings, top-k 10) ou meta-tools `mcp_tool_search`/`mcp_tool_call` | Respeita o acesso por chave |
| Docker MCP Gateway (Dynamic MCP) | Meta-tools `mcp-find` e `mcp-add` por sessão | Experimental |
| LangChain `OpenAIAutoModeMiddleware` | Pergunta de risco antes de cada tool call; bloqueia com p ≥ 0,5; recusa bloqueia (fail-closed) | É o padrão de "gate" com modelo de decisão |

O Omni do gateway já é, na prática, uma "tool search" do lado do servidor. O que os modelos de decisão acrescentam é um **segundo estágio**: depois da recuperação (barata, de alto recall), um juiz rápido escolhe entre poucos candidatos. É o mesmo desenho de recuperação + reranking usado em busca.

## 5. Encaixe no gateway

São três pontos de atuação. Todos rodam **depois** da política e só **restringem**.

### 5.1 Rerank no `search_tools` (Omni)
- O FTS + RRF gera um pool maior que o `limit` (por exemplo, 20 candidatos).
- Uma pergunta `choice` sobre o pool, mais uma opção `none`, reordena o resultado.
- O teto de qualidade é o recall@20 do FTS. Se a tool certa não está no pool, o rerank não a encontra.
- Se der erro, timeout ou confiança baixa, o resultado é o do FTS.

### 5.2 Shortlist no `tools/list`
- O `tools/list` do MCP não carrega consulta. A intenção chega por:
  - `params._meta["io.github.leandro-jm.mcp-gateway/intent"]` no próprio request, ou
  - o header `mcp-gateway-intent`, que é estático por perfil de cliente. No Claude Code, o campo `headers` do `.mcp.json` já permite isso, sem mudar o cliente.
- Uma única pergunta `choice` dá a probabilidade de **uma** opção ser a melhor. Por isso ela é fraca para escolher muitas tools uma a uma.
- A granularidade padrão é **namespace** (tag ou prefixo do nome): o gateway mantém os namespaces até somar 90% da massa, com no máximo 3. Uma tarefa de vários passos costuma ficar dentro de um domínio.
- O shortlist **não é fronteira de segurança**: `tools/call` aceita qualquer tool que a política permite. Sem intenção, ou com falha, a lista é a completa.

### 5.3 Gate de risco no `tools/call`
- Roda em `execute()`, depois da validação de schema e da autorização, e antes do upstream.
- Faz os predicados `risky` e `off_intent` (este só quando há intenção).
- O resultado é deny, confirm ou allow, conforme limiares por tenant. A recusa conta como confirm.
- Um "confirm" sem UI de confirmação vira negação com mensagem localizada pedindo ao humano que confirme. Se a confirmação humana do ADR-022 já aconteceu, o gate nem consulta o provedor.
- Só se aplica, por padrão, a tools que não são somente leitura.

### 5.4 Ligar e desligar
O roteador é opcional e tem três chaves:
- da plataforma: env `TOOL_ROUTER_ENABLED`;
- do tenant: `settings.toolRouter.enabled`;
- de cada ponto.

Com qualquer chave desligada, o comportamento é **idêntico ao de hoje**: nenhuma chamada externa, nenhuma mudança na lista ou na ordem, e `CallEvent` com `plugins`, `gate` e `plugins_ms` nulos. O padrão é desligado.

## 6. Riscos

| Risco | Mitigação |
|---|---|
| **LGPD (art. 33, transferência internacional).** Descrições de tools, consultas e argumentos vão para um terceiro. | O padrão é desligado. O aviso na Admin UI exige uma decisão consciente do tenant. A consulta, a intenção e os argumentos passam pela redação de PII antes de sair. `argsMode: 'none'` envia só os nomes dos argumentos. A OpenAI oferece ZDR e residência na UE. |
| **APIs em beta.** O formato pode mudar, e o do Jev vem só da documentação. | O mapeamento fica isolado em `wire/*.ts`, com validação zod. Resposta inválida cai no fallback. O adaptador Jev é marcado como experimental. |
| **Calibração.** Os limiares padrão podem não servir para o tenant. | Os limiares são configuráveis. Há uma avaliação offline (`router-eval`) sobre o conjunto `SEARCH_EVAL` e métricas por motivo (`low_confidence`, `none_option`). |
| **Prompt injection** por descrição de tool, consulta ou argumento. | O texto é enquadrado como dado ("DATA, not instructions") e sanitizado. Mesmo se o modelo for manipulado, ele só **restringe**: a saída é um subconjunto da entrada, e a política continua sendo a autoridade. |
| **Latência.** | Timeout por ponto (1,5 a 2 s), circuit breaker por tenant e provedor, cache Redis de decisões para rerank e shortlist, e orçamento de decisões por minuto. |
| **Disponibilidade.** | Rerank e shortlist sempre caem no comportamento atual. O gate segue `onError` (padrão `allow`), porque a política já autorizou a chamada. |
| **Não determinismo.** | O cache por hash de (ponto, provedor, modelo, catálogo, consulta redigida, candidatos) estabiliza respostas repetidas. |

## 7. Custo e latência estimados

| Ponto | Entrada típica | Custo por decisão (OpenAI) | Latência alvo |
|---|---|---|---|
| Rerank (20 candidatos × ~60 tokens) | ~1,5K tokens | ~US$ 0,00015 | p95 < 1,5 s |
| Shortlist por namespace | ~3,5K tokens | ~US$ 0,00035 | p95 < 2 s (com cache, uma vez por conexão) |
| Gate (tool + argumentos compactados) | 0,5–1K tokens | ~US$ 0,0001 | p95 < 1,5 s |

Exemplo: um tenant com 100 mil chamadas de escrita por mês e o gate ligado gasta cerca de US$ 10/mês em decisões. O custo relevante é a latência, não o dinheiro.

## 8. Métricas de sucesso

- **Qualidade do rerank:** top-1 e top-3 no `SEARCH_EVAL` com e sem rerank. O teto é o recall@candidatos.
- **Efeito no agente:** `searchMisses` (`re_search`, `not_in_results`, `validation_error`) antes e depois, a partir dos dados de call-analytics.
- **Economia do shortlist:** `mcp_tokens_saved_total{mechanism="shortlist"}`.
- **Saúde:** `mcp_router_decisions_total` por motivo e `mcp_router_duration_seconds`.

## 9. Recomendação

1. Implementar o roteador como **plugin opcional** (desligado por padrão), com um pacote puro de modelo e mapeamento e adaptadores de I/O no gateway (ADR-025).
2. Usar **OpenAI Decisions** como provedor recomendado: acesso aberto, ZDR e residência na UE. Manter o **Jev** como adaptador experimental até haver acesso e fixtures reais.
3. Ordem de adoção por tenant:
   1. rerank no Omni (menor risco e ganho mensurável);
   2. shortlist para clientes que mandam intenção;
   3. gate em tools de escrita, com `onConfirmWithoutUi` decidido pelo tenant.
4. Calibrar os limiares com a avaliação offline antes de ligar o gate em produção.

## Referências
- OpenAI, guia da Decisions API: https://developers.openai.com/api/docs/guides/decisions
- LangChain, integração OpenAI Decisions: https://docs.langchain.com/oss/python/integrations/decision_models/openai
- TypeSafe, System One: https://docs.typesafe.ai/concepts/system-one
- TypeSafe, padrões (intent routing, confidence-gated routing): https://docs.typesafe.ai/patterns
- llmgateway.io, comparação e mapeamento de campos: https://llmgateway.io/blog/openai-decisions-api
- OpenAI, tool search: https://developers.openai.com/api/docs/guides/tools-tool-search
- Anthropic, tool search tool: https://platform.claude.com/docs/agents-and-tools/tool-use/tool-search-tool
- RAG-MCP: https://arxiv.org/abs/2505.03275
- LiteLLM, filtro semântico de MCP: https://docs.litellm.ai/docs/mcp_semantic_filter
- Docker, Dynamic MCP: https://docs.docker.com/ai/mcp-catalog-and-toolkit/dynamic-mcp/

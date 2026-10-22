# ADR-025: Roteador de tools com modelos de decisão (plugin opcional)

- Status: aceito
- Data: 2026-10-22
- Depende de: ADR-009, ADR-015, ADR-016, ADR-021, ADR-022
- Estudo: [estudo-modelos-de-decisao.md](../tool-router/estudo-modelos-de-decisao.md)

## Contexto
A escolha de tools pelo agente piora com catálogos grandes. O Omni (ADR-009) recupera candidatos por FTS e embeddings, mas não desambigua a operação. O `tools/list` nativo ignora a intenção do agente. E não há um segundo olhar sobre chamadas de escrita quando o cliente não tem UI de confirmação (ADR-022).

Em 2026 surgiram APIs de **modelos de decisão**: a OpenAI Decisions API (`POST /v1/decisions`, beta pública) e o TypeSafe Jev (`POST /v1/systemone`, waitlist). Elas devolvem probabilidades calibradas para perguntas `predicate`, `choice` e `score`, em centenas de milissegundos e por centavos. Os dois formatos se mapeiam um no outro. O estudo compara essas APIs com as alternativas de mercado.

Os campos `plugins`, `gate` e `plugins_ms` do `CallEvent` e da tabela `call_events` já estão reservados (ADR-016 §2), à espera de uma pipeline de plugins.

## Decisão

### Escopo e invariantes
- O roteador é um **plugin opcional** com três pontos de atuação: **rerank** no `search_tools` do Omni, **shortlist** no `tools/list` e **gate** de risco no `tools/call`.
- Ele roda sempre **depois** da política e só **restringe**: a saída é um subconjunto da entrada. A política continua sendo a única autoridade de acesso.
- O shortlist **não é fronteira de segurança**: `tools/call` aceita qualquer tool que a política permite, mesmo fora do shortlist.
- **Falhas:**
  - rerank e shortlist com erro, timeout, circuito aberto, orçamento estourado, recusa ou confiança baixa voltam ao comportamento atual;
  - o gate segue `gate.onError` (`allow` por padrão, porque a política já autorizou; o tenant pode escolher `deny`).

### Liga/desliga
Há três chaves, e todas precisam estar ligadas para um ponto atuar:

| Chave | Padrão | Efeito quando desligada |
|---|---|---|
| Plataforma: `TOOL_ROUTER_ENABLED` | `false` | O roteador não é instanciado |
| Tenant: `settings.toolRouter.enabled` | `false` | Os três pontos ficam desligados para o tenant |
| Ponto: `rerank.enabled`, `shortlist.enabled`, `gate.enabled` | rerank `true`; shortlist e gate `false` | Só aquele ponto deixa de atuar |

Desligado, o comportamento é **idêntico ao anterior**:
- a checagem é síncrona sobre o snapshot, sem nenhuma chamada a provedor, Redis ou rate limiter;
- o pool de busca não é ampliado;
- a lista e a ordem são as de hoje;
- `plugins`, `gate` e `plugins_ms` ficam nulos.

Desligar preserva a configuração. O toggle por tenant vale sem deploy, pela invalidação de snapshot que já existe.

### Pacotes
- **`@mcp-gateway/tool-router`** (puro, sem I/O). Contém:
  - o modelo neutro de perguntas e respostas;
  - o mapeamento de wire para OpenAI e Jev;
  - os construtores de perguntas;
  - a interpretação (massa de probabilidade, confiança, limiares do gate);
  - o contrato `ToolRouterPlugin { rerank?, shortlist?, gate? }` e os combinadores que garantem as invariantes.
- **`apps/gateway/src/router/`** (I/O):
  - adaptadores HTTP sobre `outboundFetch`, com proteção SSRF;
  - o serviço `ToolRouter`, que aplica em ordem: orçamento, circuit breaker, timeout, cache, plugins, invariantes, fallback e telemetria;
  - um registro de plugins com `decision-model` como padrão.

### Rerank
- O `search_tools` busca `max(limit, rerank.candidates)` candidatos no `ToolSearch`.
- Uma pergunta `choice` sobre os candidatos, mais a opção `none`, define a nova ordem.
- `none` ou confiança abaixo de `minConfidence` mantém a ordem do FTS.

### Shortlist
- **De onde vem a intenção, em ordem:**
  1. `params._meta["io.github.leandro-jm.mcp-gateway/intent"]`;
  2. o header HTTP `mcp-gateway-intent`.
- A intenção é cortada em 512 caracteres, redigida antes de sair do gateway e registrada só como hash. Sem intenção, a lista é a completa.
- **Granularidade:**
  - padrão `namespace`, onde o namespace é a primeira tag ou o prefixo do nome: o gateway mantém os namespaces até atingir `mass`, com no máximo 3 namespaces e `maxTools` tools;
  - `tool`: candidatos do `ToolSearch` e uma pergunta `choice` sobre eles.
- O motivo do padrão: uma pergunta `choice` dá a probabilidade de uma opção ser a melhor, e é fraca para escolher muitas tools uma a uma.

### Gate
- **Posição:** em `execute()`, depois do estágio `authz` e antes do upstream, medido no estágio `plugins`. Uma composite passa por um único gate.
- **Escopo:** `gate.scope` = `non-readonly` (padrão), `destructive` ou `all`.
- **Perguntas:** os predicados `risky` e, com intenção, `off_intent`.
- **Resultado:**
  - p ≥ `denyAt` (0,9): deny;
  - p ≥ `confirmAt` (0,5): confirm;
  - abaixo disso: allow;
  - recusa: confirm.
- **Confirm:**
  - se o token de confirmação do ADR-022 já foi consumido, o servidor marca `ctx.ui.confirmed` e o gate não consulta o provedor (`human_confirmed`). O campo nunca é lido do `_meta` do cliente;
  - nos outros casos vale `onConfirmWithoutUi` (`deny` por padrão, com a mensagem `router.confirmationRequired`).
- **Deny:** vira `Forbidden` com motivo `router_gate` na auditoria e `CallEvent.gate = {required, outcome, reason}`.
- **Argumentos enviados:** com `argsMode: 'redacted'` (padrão), passam por `PiiService.redactForLog` e são compactados (200 caracteres por string, 4 KB no total). Com `argsMode: 'none'`, vão só os nomes e os tipos.

### Configuração e segredos
- **Comportamento:** em `tenants.settings.toolRouter`, lido por `readToolRouterSettings` no `core`. Não é segredo, então vai no snapshot.
- **Provedor e chave:** em uma tabela própria, `tenant_decision_settings` (migration 0024):
  - colunas: provider (`openai_decisions | jev`), model, `base_url` opcional (validada contra SSRF), chave criptografada com AAD `decision-settings:<tenantId>` e hint.
  - É separada de `tenant_llm_settings` (ADR-015) porque o provedor de decisão é outro produto, com outra chave, e o Composer continua com o seu.
- **Admin API** (`gateway-admin`, com auditoria):
  - `GET|PUT /settings/tool-router`;
  - `PUT|DELETE /settings/tool-router/provider`;
  - `POST /settings/tool-router/test`.
- **Admin UI:** uma aba "Roteador" em Configurações, com aviso sobre o processamento de dados por terceiro.

### Proteções operacionais
- Timeout por ponto: 1,5 s no rerank e no gate, 2 s no shortlist; no máximo 5 s.
- Circuit breaker por `tenant:router:provider`.
- Orçamento `maxDecisionsPerMinute` no rate limiter que já existe.
- Cache Redis das decisões de rerank e shortlist (TTL `cacheTtlSeconds`), com chave = hash do ponto, provedor, modelo, catálogo, consulta redigida e candidatos. O gate nunca usa cache.

### Telemetria
- `CallEvent.plugins[]` recebe `PluginDecision` com:
  - `plugin`, `point`, `decision`, `ms`, `provider`, `model`;
  - `confidence` em faixa (`low | medium | high`), `cached`, `candidates`, `kept`;
  - `reason` de um conjunto fechado.
- Nenhum texto de consulta, intenção ou argumento entra no evento.
- Métricas derivadas do evento: `mcp_router_decisions_total`, `mcp_router_duration_seconds` e `mcp_tokens_saved_total{mechanism="shortlist"}`.

## Consequências
- Os tenants podem reduzir contexto e melhorar a escolha de tools sem mudar o cliente (no caso do header) e sem abrir mão da política.
- Ligar o roteador inclui um novo operador de dados (OpenAI ou TypeSafe). Isso é uma decisão do tenant, registrada na auditoria, e o padrão é desligado.
- O adaptador Jev fica **experimental** até haver acesso e fixtures de chamadas reais, porque o formato vem só da documentação.
- O limite de opções da OpenAI não é documentado. `PROVIDER_LIMITS` adota 64, de forma conservadora.
- O gate acrescenta latência às chamadas de escrita, limitada pelo timeout e pelo escopo padrão `non-readonly`.
- Os campos reservados `plugins`, `gate` e `plugins_ms` do ADR-016 passam a ser preenchidos. `taint` continua reservado.

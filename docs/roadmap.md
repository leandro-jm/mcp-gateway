# Roadmap — MCP Gateway

> Plano de implementação, executado task a task com agentes de código (veja `AGENTS.md`). O código e os ADRs se referem a este documento como "PLAN" (ex.: "PLAN F5.3", "PLAN §6").
> Inspirado na arquitetura de MCP Gateway descrita publicamente pela Uber (§1.1).
> Escopo v1: upstreams **REST/OpenAPI**; serviço **standalone** em **TypeScript**; consumido por qualquer cliente MCP (Claude Code, frameworks de agentes, clientes próprios).

---

## 0. Como usar este plano com agentes de código

- Execute **uma task por vez**, na ordem. Cada task tem ID (`F2.3`), entregáveis e critérios de aceite (CA).
- Antes de cada task: ler a seção de arquitetura relevante (§2) e o modelo de dados (§3).
- Uma task só está concluída quando: testes passam (`pnpm test`), lint/typecheck passam (`pnpm check`) e todos os CA estão atendidos.
- Não antecipar fases futuras. Se uma decisão não estiver coberta aqui, registrar em `docs/decisions/ADR-xxx.md` antes de implementar.
- Commits pequenos, mensagem no formato `F2.3: <descrição>`.

---

## 1. Visão geral

### 1.1 Mapeamento das funcionalidades da Uber

| Uber | Neste projeto | Fase |
|---|---|---|
| MCP Registry (control plane) | Registry multi-tenant de fontes, servidores virtuais e tools, com Admin API | F1 |
| AutoCrawler (scan de IDLs, geração de tools) | Crawler de OpenAPI → tools "agent-friendly", registradas **desabilitadas por padrão**, com detecção de drift | F2 |
| Heartbeat de servidores MCP nativos | Fora da v1 (extension point em §8) | — |
| Proxy Gateway (data plane) MCP → HTTP/gRPC/TChannel | Proxy MCP (Streamable HTTP) → REST, sem mudança nos serviços downstream | F3 |
| Credenciais por upstream | Credential vault + token manager (client_credentials, password, API key, bearer estático) | F3 |
| Autorização por tool | AuthN por token opaco (usuários e tokens no Postgres, ADR-011) + políticas por tenant/role/client/tool, default deny | F4 |
| PII redaction | Motor de redaction em request e response, com detectores BR (CPF, CNPJ, PIS etc.) e estratégias mask/hash/drop/tokenize | F5 |
| Response Projection | Projeção por tool (allow/deny de campos via JSONPath, limites de array/bytes) + `_fields` opcional pelo agente | F6 |
| Omni MCP (descoberta incremental) | Endpoint `/mcp/omni` com meta-tools `search_tools` / `get_tool_schema` / `call_tool` + `tools/list_changed` | F7 |
| — (extensão própria) | Tools compostas (orquestração de vários endpoints no gateway), tools manuais e criação self-service de MCPs (virtual servers) | F7b |
| aifx Code Mode (tool calls baseadas em arquivo) | Respostas grandes viram artefatos (`artifact://`), com leitura/consulta parcial e inputs por referência; SDK TS gerado para agentes com execução de código | F8 |
| Observabilidade | Audit log por chamada, métricas, traces OpenTelemetry | F9 |
| Fluxo de "owner habilita a tool" | Admin UI para revisar, editar e habilitar tools | F10 |
| — (extensão própria) | Composer em linguagem natural: LLM do tenant monta a composta, com grafo, dry-run e assistente de publicação | F14 |
| — (extensão própria) | Observabilidade de agentes: evento largo por chamada, visões por público, explorador de chamadas, trajetórias, sugestão de compostas e MCP de observabilidade | F15 |

> Observação: a Uber não publica todos os detalhes de Omni MCP e Code Mode. As F7 e F8 implementam a **intenção** descrita (descoberta incremental, redução de contexto via arquivos), com desenho próprio.

### 1.2 Princípios

1. **Default deny**: tool descoberta nasce `disabled`; tool habilitada sem política não é acessível.
2. **Downstream intocado**: nenhuma API de cliente precisa mudar.
3. **Agente nunca vê credencial**: credenciais vivem só no gateway.
4. **PII sai mascarada do gateway**: redaction acontece antes de qualquer byte chegar ao modelo.
5. **Contexto é recurso escasso**: projeção, descoberta incremental e artefatos são first-class.
6. **Tudo auditável**: toda chamada gera evento de auditoria (sem payload sensível em claro).

---

## 2. Arquitetura

### 2.1 Componentes

```
                ┌────────────────────────── Control plane ──────────────────────────┐
 Admin UI ────▶ │ Admin API (/admin/v1)  ─▶ Registry (Postgres)  ◀─ Crawler worker   │
                │                                ▲                   (OpenAPI scan) │
                └────────────────────────────────┼──────────────────────────────────┘
                                                 │ cache (Redis, invalidação por evento)
                ┌──────────────────────────── Data plane ───────────────────────────┐
 Agentes ─────▶ │ /mcp  /mcp/omni  /mcp/s/:server                                   │
 (MCP client)   │   AuthN (token opaco) → AuthZ (policy) → Arg validation           │
                │   → Input detokenize/resolve artifact refs                        │
                │   → REST translator + credential injection ─▶ API upstream        │
                │   ◀ Response: PII redaction → Projection → Artifact offload       │
                │   → Audit + metrics + traces                                      │
                └───────────────────────────────────────────────────────────────────┘
```

### 2.2 Stack

- Node 22 LTS, TypeScript estrito, pnpm workspaces
- HTTP: Fastify
- MCP: `@modelcontextprotocol/sdk` (transport Streamable HTTP, stateless onde possível)
- Validação: Zod (+ conversão JSON Schema ↔ Zod onde necessário; Ajv para validar args contra schema gerado)
- OpenAPI: `@apidevtools/swagger-parser` (dereference de `$ref`, OpenAPI 3.0/3.1 e Swagger 2.0)
- Banco: Postgres + Drizzle ORM + migrations; `pgvector` opcional (F7)
- Cache, rate limit, sessões: Redis
- Artefatos: S3-compatible (MinIO local)
- Auth: usuários e tokens opacos no Postgres (hash SHA-256; senhas com scrypt), ADR-011
- Jobs: BullMQ (Redis)
- Observabilidade: pino (logs), OpenTelemetry (traces/métricas), Prometheus endpoint
- Testes: Vitest + Testcontainers (Postgres/Redis/MinIO) + upstream fake (Fastify) com OpenAPI de exemplo
- Deploy: Docker + docker-compose; stack Portainer; CI no GitHub Actions

### 2.3 Estrutura do repositório

```
mcp-gateway/
  apps/
    gateway/          # data plane + admin API (mesmo processo, módulos separados)
    crawler/          # worker BullMQ (discovery, geração, drift)
    admin-ui/         # F10
  packages/
    core/             # tipos de domínio, erros, utilitários
    db/               # schema Drizzle, migrations, repositórios
    openapi-toolgen/  # OpenAPI → ToolDefinition (puro, sem I/O)
    policy/           # motor de autorização (puro)
    redaction/        # detectores e estratégias de PII (puro)
    projection/       # projeção de respostas (puro)
    artifacts/        # store de artefatos (S3)
    testkit/          # upstream fake, fixtures OpenAPI, Testcontainers
  docs/
    decisions/        # ADRs
    roadmap.md        # este plano
  docker/
  AGENTS.md
  CLAUDE.md
```

Regra: pacotes em `packages/` com lógica pura não fazem I/O, o que facilita testar.

---

## 3. Modelo de dados (Postgres)

| Tabela | Campos principais |
|---|---|
| `tenants` | id, slug, name, status, settings (jsonb) |
| `users` | id, tenant_id (nulo = admin de plataforma), username, display_name, kind (`human` \| `service`), password_hash (scrypt), roles, groups, attributes (jsonb), status |
| `api_tokens` | id, user_id, name, kind (`session` \| `api`), token_hash (SHA-256), prefix, expires_at, last_used_at, revoked_at |
| `upstream_sources` | id, tenant_id, name, openapi_url \| openapi_inline, base_url, credential_id, crawl_schedule, owner_team, status, last_crawl_at |
| `credentials` | id, tenant_id, type (`oauth2_client_credentials` \| `oauth2_password` \| `api_key` \| `bearer_static` \| `basic`), config_encrypted (AES-256-GCM, envelope key), rotated_at |
| `tools` | id, tenant_id, kind (`openapi` \| `manual` \| `composite`), source_id (nulo para `composite`), composite_def_id, name, title, description, operation_ref (method + path + operationId), input_schema, output_schema, annotations (readOnlyHint, destructiveHint, idempotentHint), state (`disabled` \| `enabled` \| `deprecated` \| `removed`), spec_hash, version, owner_team, overrides (jsonb), created_at, updated_at |
| `tool_versions` | id, tool_id, version, spec_hash, input_schema, output_schema, diff (jsonb), created_at |
| `virtual_servers` | id, tenant_id, slug, description, tool_selector (lista de ids ou padrões) |
| `policies` | id, tenant_id, subject_type (`role` \| `client` \| `user` \| `group`), subject, effect (`allow` \| `deny`), tool_pattern, conditions (jsonb: horário, rate, args constraints), priority |
| `composite_definitions` | id, tenant_id, tool_id, version, input_schema, steps (jsonb: DAG), output_mapping (JSONata), failure_mode (`abort` \| `partial`), timeout_ms, depends_on_tools (uuid[]), status (`draft` \| `valid` \| `invalid`), validation_errors |
| `pii_rules` | id, tenant_id, scope (`global` \| `source` \| `tool`), scope_ref, detector, field_selector (JSONPath ou nome), strategy (`mask` \| `hash` \| `drop` \| `tokenize`), direction (`request` \| `response` \| `both`) |
| `projections` | id, tool_id, include (JSONPath[]), exclude (JSONPath[]), max_array_items, max_bytes, allow_agent_fields (bool) |
| `pii_tokens` | token, tenant_id, value_encrypted, expires_at (para `tokenize`) |
| `artifacts` | id, tenant_id, session_id, tool_call_id, uri, content_type, size_bytes, row_count, schema_summary, expires_at |
| `crawl_runs` | id, source_id, status, started_at, finished_at, stats (jsonb), error |
| `drift_events` | id, tool_id, kind (`added` \| `changed` \| `removed` \| `breaking`), diff, acknowledged_by, created_at |
| `audit_events` | id, ts, tenant_id, subject, client_id, tool_id, decision, status_code, latency_ms, redactions_count, projected_bytes_saved, artifact_id, trace_id (particionada por mês) |
| `tenant_llm_settings` | tenant_id (PK), provider (`anthropic` \| `openai` \| `openai_compatible`), model, base_url, api_key_encrypted (data key do tenant), api_key_hint, json_mode, max_generations_per_hour (ADR-015) |
| `call_events` | ts, call_id (UUIDv7), parent_call_id, tenant_id, kind, endpoint, identidade (subject sanitizado, client_id, agent_name/version, session_key/source, virtual_server_id, trace_id), tool (id, name, version, kind, source_id), desfecho (decision, error_code/stage, upstream_status, attempts), política (rule_id, reason, version, trace), dados (redactions por detector, bytes antes/depois da projeção, artifact), latências por etapa, overhead_ms (gerado), tokens estimados, campos reservados (plugins, gate, taint, pinned_version) (particionada por dia, ADR-016) |
| `call_rollups_hourly` / `usage_rollups_daily` | agregados por hora (tool, source, client, agente, VS, endpoint, decisão, erro; somas e histograma de latência) e por dia (subject, client, agente) |
| `call_subject_refs` | ts, tenant_id, call_id, detector, fp (HMAC), direction, subject, client_id, agent_name, tool_name, decision (particionada por mês, ADR-017) |
| `debug_captures` / `debug_capture_items` | captura opt-in (filtro, teto, prazo, motivo) e itens cifrados no S3 com TTL (ADR-017) |
| `agent_findings` / `tool_transitions_daily` / `composite_suggestions` / `call_outcomes` | analytics de agente: padrões ruins por sessão, co-uso, sugestões de composta e desfechos reportados (ADR-016) |

---

## 4. Fases e tasks

### F0 — Fundação

**F0.1 Bootstrap do monorepo**
- pnpm workspaces, tsconfig base estrito, ESLint + Prettier, Vitest, scripts `check`, `test`, `build`, `dev`.
- `CLAUDE.md` com convenções do repo (estrutura, comandos, regra de pacotes puros, formato de commit).
- CA: `pnpm check && pnpm test` verde num repo vazio com um teste dummy por pacote.

**F0.2 Infra local**
- `docker-compose.dev.yml`: Postgres (com pgvector), Redis e MinIO. O seed de dev cria os usuários `admin`, `owner`, `agente` e o usuário service `agent-dev` com token fixo (roles `gateway-admin`, `tool-owner`, `agent`).
- CA: `pnpm dev:infra` sobe tudo; healthchecks verdes.

**F0.3 Testkit**
- Upstream fake (Fastify) com OpenAPI 3.1 de exemplo de RH: `GET /colaboradores`, `GET /colaboradores/{id}`, `GET /escalas`, `POST /marcacoes`, `DELETE /marcacoes/{id}`. Respostas com CPF, e-mail, telefone e salário fictícios; endpoint de token OAuth2 fake.
- Helpers para subir Testcontainers (os tokens de teste são emitidos pelo harness do gateway, direto no banco).
- CA: testes conseguem subir upstream fake e chamar com token.

**F0.4 Config e erros**
- Config tipada via Zod a partir de env; catálogo de erros de domínio (`ToolNotFound`, `ToolDisabled`, `Forbidden`, `UpstreamError`, `ValidationError`) com mapeamento para erros MCP.
- CA: app falha no boot com mensagem clara se faltar env obrigatória.

---

### F1 — Registry (control plane)

**F1.1 Schema e migrations**
- Implementar §3 em Drizzle (exceto `pii_tokens`, `artifacts` e particionamento de `audit_events`, que entram nas fases respectivas).
- CA: migrations sobem e descem; seed de dev cria 1 tenant + 1 source apontando para o upstream fake.

**F1.2 Criptografia de credenciais**
- Envelope encryption: master key via env (`GATEWAY_MASTER_KEY`), data key por tenant; AES-256-GCM.
- CA: credencial nunca aparece em claro no banco, nos logs ou nas respostas da Admin API (teste de vazamento).

**F1.3 Admin API — tenants, sources, credentials**
- `/admin/v1/tenants`, `/sources`, `/credentials` (CRUD), com auth pela role `gateway-admin`.
- `POST /sources/:id/crawl` enfileira crawl (o worker vem na F2).
- CA: OpenAPI da própria Admin API publicada em `/admin/v1/openapi.json`; testes de contrato.

**F1.4 Admin API — tools e virtual servers**
- Listar/filtrar tools (por source, state, owner), ver versões e diffs.
- `PATCH /tools/:id`: overrides de nome, descrição e schema (o override sobrevive a re-crawl).
- `POST /tools/:id/enable | disable | deprecate`, permitido a `tool-owner` do `owner_team` ou a `gateway-admin`.
- CRUD de `virtual_servers`.
- CA: transições de estado validadas (ex.: `removed` não volta a `enabled`); toda transição gera audit event.

**F1.5 Cache do registry no data plane**
- Snapshot por tenant no Redis; invalidação via pub/sub em qualquer mudança de tool, policy, projeção ou regra de PII.
- CA: mudança na Admin API reflete no data plane em < 2 s sem restart.

---

### F2 — AutoCrawler (OpenAPI → tools)

**F2.1 Worker e agendamento**
- App `crawler` com BullMQ; jobs `crawl-source` (manual ou cron por source) e `crawl-all`.
- Registro em `crawl_runs` com stats (operações encontradas, tools criadas/alteradas/removidas).
- CA: crawl manual via Admin API executa e registra o run.

**F2.2 Parser e normalização**
- Baixar spec (com credencial, se necessário) ou usar inline; `dereference`; suportar Swagger 2.0, OAS 3.0 e 3.1.
- CA: fixtures de 3 specs (uma por versão) normalizam para o mesmo modelo interno.

**F2.3 Geração de tools agent-friendly** (`packages/openapi-toolgen`)
- Nome: `{source}_{recurso}_{verbo}` em snake_case, ≤ 64 chars, estável (derivado de `operationId` quando existir; senão, de método + path); colisões resolvidas de forma determinística.
- Descrição: `summary` + `description` limpos de markdown/HTML, truncados (≤ 1.024 chars), mais uma linha sobre efeito ("Somente leitura" / "Altera dados").
- Input schema: um objeto único achatando path, query, header (exceto auth) e body; nomes de campos sem colisão; remover `readOnly` do body; limitar profundidade (configurável, padrão 5); converter `oneOf`/`anyOf` complexos em descrição quando ultrapassarem o limite.
- Output schema: da resposta 2xx principal (usado pela F6 e F8).
- Annotations: GET/HEAD → `readOnlyHint: true`; DELETE → `destructiveHint: true`; PUT → `idempotentHint: true`.
- Ignorar operações marcadas `deprecated` ou com extensão `x-mcp-ignore: true`; respeitar `x-mcp-name` e `x-mcp-description` como overrides vindos do dono da API.
- CA: snapshot tests sobre as fixtures; o schema gerado valida payloads reais do upstream fake.

**F2.4 Registro com "disabled by default"**
- Tool nova → `state = disabled`, `version = 1`, `spec_hash`.
- Tool existente com hash diferente → nova `tool_versions`, mantém o estado atual se a mudança for **não breaking**; se for **breaking** (campo obrigatório novo, campo removido, tipo alterado), move para `disabled` e cria `drift_event` do tipo `breaking`.
- Operação sumiu da spec → `state = removed` + `drift_event`.
- Overrides manuais (F1.4) são reaplicados sobre a nova versão.
- CA: suíte cobrindo os 4 cenários (nova, mudança compatível, breaking, removida).

**F2.5 Notificação de drift**
- Webhook configurável por tenant/owner_team (payload com diff resumido).
- CA: evento breaking dispara webhook uma única vez (idempotente por `drift_event.id`).

---

### F3 — Proxy (data plane)

**F3.1 Endpoint MCP**
- `POST/GET /mcp` (Streamable HTTP) usando o SDK oficial; também `/mcp/s/:serverSlug` para virtual servers.
- `initialize` com capabilities `tools` (listChanged: true) e `resources` (para F8).
- `tools/list` retorna apenas tools `enabled` **e** permitidas pela política do sujeito (até a F4, usar stub "allow all enabled").
- CA: o MCP Inspector conecta, lista e chama tools do upstream fake.

**F3.2 Tradutor MCP → REST**
- A partir do `operation_ref`: montar URL (path params com encoding), query, headers e body; timeout por source; retries só em idempotentes (GET/PUT/DELETE) com backoff.
- Mapear respostas: 2xx → `content` (JSON como texto + `structuredContent` quando houver output schema); 4xx → erro de tool com mensagem útil ao agente (sem stack); 5xx/timeout → erro com `isError: true` e código.
- Validar args com Ajv antes de chamar o upstream.
- CA: testes para cada método HTTP, encoding de path, arrays em query, body JSON e erros.

**F3.3 Credential manager**
- Injeção por tipo de credencial; token manager com cache em Redis até `expires_in - margem`, refresh com lock distribuído (evita estouro de requisições no endpoint de token).
- CA: 50 chamadas concorrentes geram 1 único request de token; token expirado é renovado de forma transparente.

**F3.4 Guardas de tráfego**
- Rate limit por tenant, por client e por tool (Redis, sliding window); limite de tamanho de request e response; circuit breaker por source.
- CA: limites configuráveis via `tenants.settings`; teste de cada guarda.

---

### F4 — Autenticação e autorização por tool

**F4.1 AuthN**
- Validar token opaco (`Authorization: Bearer`) contra o Postgres, com cache curto; o principal vem do usuário dono do token: `sub` (username), tenant, `roles`, `groups`, atributos (`claims.*`) e `client_id` (nome do token). Ver ADR-011.
- Login da Admin UI (`POST /auth/login`) com token de sessão; CRUD de usuários e tokens na Admin API.
- CA: token inválido, expirado, revogado ou de outro tenant → 401; revogação vale em até 15 s em todas as réplicas.

**F4.2 Motor de políticas** (`packages/policy`)
- Avaliação: default deny → regras `allow` por especificidade → `deny` explícito vence → condições (`conditions`: janelas de horário, constraints em args como `args.unidade_id in claims.unidades`).
- `tool_pattern` aceita glob (`rh_colaboradores_*`) e seletor por annotation (`annotation:readOnlyHint`).
- Regra de segurança: tools com `destructiveHint` exigem allow explícito por nome ou pattern (não são cobertas por allow genérico `*`).
- CA: tabela de casos (≥ 30) cobrindo precedência, condições e regra destrutiva.

**F4.3 Integração no data plane**
- `tools/list` filtrado por política; `tools/call` reavalia (nunca confia só no list).
- Admin API: CRUD de policies + `POST /policies/simulate` (sujeito + tool + args → decisão e regra aplicada).
- CA: um agente sem permissão não vê nem consegue chamar a tool; o simulate explica a decisão.

---

### F5 — PII redaction

**F5.1 Detectores** (`packages/redaction`)
- Por valor: CPF e CNPJ (regex + dígito verificador), e-mail, telefone BR, PIS/NIS (com DV), CEP, cartão (Luhn), IBAN/conta bancária por padrão configurável.
- Por nome de campo (case-insensitive, sinônimos configuráveis): `salario`, `remuneracao`, `rg`, `cnh`, `data_nascimento`, `cid`, `atestado`, `endereco`, `conta`, `agencia` etc.
- CA: suíte com verdadeiros e falsos positivos (ex.: número de 11 dígitos que não é CPF válido não é mascarado por valor).

**F5.2 Estratégias**
- `mask` (ex.: `***.456.789-**`), `hash` (HMAC-SHA256 com chave do tenant, para permitir correlação sem revelar), `drop` (remove o campo), `tokenize` (substitui por `pii_tok_xxx`, reversível só dentro do gateway).
- CA: cada estratégia testada em objetos aninhados e arrays.

**F5.3 Pipeline e regras**
- Aplicar na response antes de projeção e artefatos; aplicar na request (logs e auditoria nunca guardam PII em claro).
- Precedência das regras: tool > source > global. Política padrão do tenant: `mask` para documentos, `drop` para saúde e salário.
- Contar redactions por chamada → `audit_events.redactions_count`.
- CA: nenhum fixture do upstream fake retorna CPF, salário ou e-mail em claro com a política padrão.

**F5.4 Tokenização reversível (detokenize em inputs)**
- Se o agente envia `pii_tok_xxx` como argumento numa chamada posterior, o gateway troca pelo valor real antes do upstream (somente mesmo tenant, token não expirado, e tool autorizada para aquele campo).
- CA: o fluxo "buscar colaborador → registrar marcação para ele" funciona sem o CPF real nunca chegar ao agente.

---

### F6 — Response Projection

**F6.1 Motor de projeção** (`packages/projection`)
- `include` / `exclude` via JSONPath; `max_array_items` com metadado `{ truncated: true, total: N }`; `max_bytes` com corte seguro (nunca gera JSON inválido).
- CA: testes com payloads grandes do upstream fake; redução de bytes medida.

**F6.2 Projeção por tool + campos pedidos pelo agente**
- Config em `projections` (Admin API); se `allow_agent_fields`, injetar no input schema o parâmetro opcional `_fields: string[]` (caminhos simples, ex.: `["id","nome","escala.inicio"]`), interseccionado com o `include` permitido.
- Gerar projeção padrão sugerida no crawl: para listas, campos escalares de primeiro nível com até N campos (fica como sugestão, desabilitada até o owner aprovar).
- CA: `projected_bytes_saved` gravado na auditoria; `_fields` nunca expõe campo excluído pela política.

---

### F7 — Omni MCP (descoberta incremental)

**F7.1 Índice de busca de tools**
- Índice por tenant com nome, título, descrição, nomes de parâmetros e tags; busca keyword (Postgres FTS, config `portuguese` + `simple`) e, opcionalmente, embeddings (`pgvector`) com ranking híbrido.
- Respeitar política: a busca só retorna tools que o sujeito pode chamar.
- CA: dado um conjunto de 200 tools sintéticas, consultas em linguagem natural trazem a tool certa no top-3 em ≥ 90% dos casos do conjunto de avaliação (fixture).

**F7.2 Endpoint `/mcp/omni`**
- Expõe apenas 3 meta-tools:
  - `search_tools(query, limit=5)` → nome, título e descrição curta
  - `get_tool_schema(name)` → input schema completo + annotations
  - `call_tool(name, arguments)` → mesma pipeline do proxy (authz, PII, projeção, artefatos)
- Modo alternativo (flag de sessão): após `search_tools`, adicionar as tools encontradas à sessão e emitir `notifications/tools/list_changed`, para clientes que lidam melhor com tools nativas.
- CA: um agente de teste resolve uma tarefa com 200 tools disponíveis usando < 15% dos tokens de definição de tools em relação ao `/mcp` completo (medido no teste).

---

### F7b — Composição de tools e criação de MCP

Objetivo: permitir que owners criem tools de mais alto nível (orquestrando vários endpoints dentro do gateway), tools manuais para endpoints sem OpenAPI, e publiquem MCPs próprios (virtual servers) sem código.

**F7b.1 Tools manuais**
- Admin API para criar tool `kind = manual` a partir de: source (base_url + credencial), método, path template, mapeamento de parâmetros (path/query/header/body), input schema e output schema (opcional; pode ser inferido de uma resposta de exemplo).
- Passa pela mesma pipeline do proxy (authz, PII, projeção, artefatos) e nasce `disabled`.
- Crawls não sobrescrevem tools manuais; se uma operação OpenAPI equivalente surgir, gera aviso (não substitui).
- CA: tool manual para um endpoint do upstream fake sem entrada na spec funciona ponta a ponta.

**F7b.2 Linguagem de composição** (`packages/composition`, puro)
- Definição declarativa (YAML/JSON) validada por Zod:
  ```yaml
  name: rh_resumo_colaborador
  description: Dados do colaborador, escala atual e últimas marcações
  input:
    type: object
    required: [colaborador_id]
    properties:
      colaborador_id: { type: string }
      desde: { type: string, format: date }
  steps:
    - id: colab
      tool: rh_colaboradores_get
      args: { id: "$input.colaborador_id" }
    - id: escalas
      tool: rh_escalas_list
      args: { colaborador: "$steps.colab.id" }
    - id: marcacoes
      tool: rh_marcacoes_list
      args: { colaborador: "$steps.colab.id", desde: "$input.desde" }
      when: "$exists($input.desde)"
  output: |
    {
      "nome": $steps.colab.nome,
      "escala_atual": $steps.escalas[0],
      "ultimas_marcacoes": $steps.marcacoes[[0..9]]
    }
  failure_mode: partial
  timeout_ms: 8000
  ```
- Expressões em JSONata (mesma escolha do ADR da F8.3; se a F8 ainda não existir, este ADR fixa a escolha).
- Recursos: dependências inferidas a partir das referências `$steps.*` (DAG); `when` (condicional); `foreach` com `max_items` e `concurrency` para fan-out sobre listas; valores default; renomear/converter tipos.
- Um step só pode referenciar tools (`openapi` ou `manual`), não outras compostas (sem recursão na v1).
- CA: validador rejeita ciclos, referências a steps inexistentes, tools inexistentes ou `removed`, e args incompatíveis com o input schema da tool referenciada (checagem estática onde possível).

**F7b.3 Executor**
- Executa o DAG com paralelismo onde não há dependência; timeout global e por step; `failure_mode`:
  - `abort`: falha de qualquer step → erro da tool com o step que falhou
  - `partial`: retorna o output com os steps falhos como `null` e um bloco `_errors` por step
- Cada step reutiliza a pipeline interna do proxy **sem** redaction (os dados brutos ficam só em memória do gateway); redaction, projeção e offload em artefato acontecem **uma vez, no output final**.
- Cache opcional por step dentro da mesma execução (mesmo tool + args).
- CA: composição de 3 steps com 2 paralelos executa em ~max(latências) e não em soma; testes para `abort`, `partial`, `when`, `foreach` e timeout.

**F7b.4 Segurança da composição**
- **Authz por step com a identidade de quem chamou**: o chamador precisa de permissão na tool composta **e** em cada tool usada nos steps. Sem isso, a composta vira caminho de escalada de privilégio.
- Annotations herdadas: se algum step for destrutivo, a composta é `destructiveHint: true` e exige allow explícito (regra da F4.2); só é `readOnlyHint` se todos os steps forem.
- Limites: máximo de steps, de chamadas totais por execução (contando `foreach`) e de bytes intermediários (configuráveis por tenant).
- Auditoria: evento da composta + eventos filhos por step, ligados por `parent_call_id`.
- CA: um sujeito com permissão na composta mas sem permissão em um step recebe `Forbidden` indicando o step; testes de limite de fan-out.

**F7b.5 Ciclo de vida e drift**
- Composta nasce `disabled`, com versionamento igual às demais tools.
- Se uma tool referenciada sofre drift `breaking`, for desabilitada ou removida, a composta vai para `disabled`, `composite_definitions.status = invalid`, e um `drift_event` é gerado para o owner da composta.
- `POST /admin/v1/composites/:id/dry-run`: executa com args de exemplo como um sujeito simulado e retorna o resultado de cada step (bruto só para `gateway-admin`) e o output final.
- CA: teste ponta a ponta de drift em cascata (tool base breaking → composta invalidada → webhook).

**F7b.6 Criação self-service de MCP (virtual servers)**
- Evoluir `virtual_servers` (F1.4): slug, nome, descrição/instruções do servidor (enviadas no `initialize`), seleção de tools (ids, globs, tags, kinds), modo (`full` ou `omni`), ícone/metadados.
- Publicação gera endpoint `/mcp/s/:slug` (e `/mcp/s/:slug/omni`) e um snippet de configuração para clientes MCP (Claude, genérico).
- A visibilidade continua sujeita à política do chamador: o virtual server define o **catálogo**; a política define o **acesso**.
- CA: owner cria um MCP "rh-gestor" com 2 compostas e 3 tools base pela API, e um cliente MCP conecta e vê só o permitido.

---

### F8 — Code Mode / tool calls baseadas em arquivo

**F8.1 Store de artefatos** (`packages/artifacts`)
- MinIO/S3, chave `tenant/session/tool_call_id`; TTL configurável; conteúdo já redigido (PII) e projetado.
- CA: artefato expira e é limpo por job; acesso só pelo mesmo tenant/sessão.

**F8.2 Offload automático de respostas grandes**
- Se a resposta (pós-redaction e pós-projeção) passar de `artifact_threshold_bytes`: salvar como artefato e retornar ao agente `{ artifact_uri, size_bytes, row_count, schema_summary, preview (primeiros N itens) }` + `resource_link` MCP.
- O agente também pode forçar com `_output: "artifact"`.
- CA: resposta de 5 MB retorna < 2 KB de contexto com preview útil.

**F8.3 Meta-tools de artefato**
- `artifact_read(uri, offset, limit)` para paginar arrays ou bytes.
- `artifact_query(uri, expression)` com JSONata ou JMESPath (escolher um e registrar ADR) para filtrar e agregar sem trazer tudo ao contexto.
- Exposição como MCP `resources` (`resources/read` em `artifact://...`).
- CA: o agente responde "quantos colaboradores por escala" sobre um artefato de 10k itens usando só `artifact_query`.

**F8.4 Inputs por referência**
- Qualquer argumento pode ser `{ "$artifact": "artifact://...", "path": "$.items[*].id" }`; o gateway resolve antes de chamar o upstream (respeitando tamanho máximo).
- CA: o fluxo "listar 500 marcações → reprocessar em lote" passa os ids por referência, sem o agente copiá-los.

**F8.5 SDK tipado para agentes com execução de código**
- `GET /sdk/:tenant.d.ts` e `/sdk/:tenant.ts`: cliente TypeScript gerado a partir das tools que o sujeito pode usar (funções tipadas que chamam `/mcp`).
- Útil para agentes que escrevem e executam código em sandbox, em vez de chamar tool a tool.
- CA: SDK gerado compila (`tsc --noEmit`) e um script de exemplo executa contra o upstream fake.

---

### F9 — Observabilidade e auditoria

**F9.1 Audit log**
- Evento por `tools/call` e por decisão de autorização negada; particionamento mensal; retenção configurável.
- `GET /admin/v1/audit` com filtros (tenant, client, tool, período, decisão).
- CA: nenhum campo do evento contém PII em claro (teste varrendo eventos com os detectores da F5).

**F9.2 Métricas e traces**
- OpenTelemetry: span por chamada (authz, upstream, redaction, projeção, offload); métricas de latência p50/p95/p99 por tool, taxa de erro por source, bytes economizados por projeção e offload, redactions por detector.
- `/metrics` Prometheus.
- CA: dashboard de exemplo (JSON do Grafana) em `docs/observability/`.

**F9.3 Health e readiness**
- `/healthz` (processo) e `/readyz` (Postgres, Redis, S3).
- CA: readiness falha corretamente quando uma dependência cai.

---

### F10 — Admin UI (fluxo do owner)

**F10.1 App** (`apps/admin-ui`, React + Vite + TS, login com usuário e senha)
- Telas: Sources (status de crawl), Tools (filtro por estado/owner/kind, diff entre versões, editar overrides, habilitar/desabilitar), Tool manual (formulário + teste), Composer (editor YAML com validação em tempo real, visualização do DAG e dry-run), MCP Servers (criar/editar virtual servers, seleção de tools, snippet de conexão), Drift inbox, Policies (com simulador), PII rules (com preview aplicado a um payload de exemplo), Projections (com preview de bytes economizados), Audit, Usuários e Tokens.
- CA: um owner consegue, sem API manual, revisar uma tool nova, ajustar a descrição, definir projeção, habilitar e testar com o simulador.

**F10.2 Playground**
- Chamar uma tool como um sujeito simulado e ver a resposta final (pós-redaction e pós-projeção) lado a lado com a resposta bruta (bruta visível só para `gateway-admin`).
- CA: diferenças destacadas visualmente.

---

### F11 — Hardening e deploy

**F11.1 Segurança**
- Testes de: SSRF (base_url e openapi_url restritas a allowlist por tenant; bloquear IPs privados por padrão), injeção em path params, isolamento entre tenants (suíte dedicada), headers sensíveis nunca repassados ao agente.
- CA: suíte `security/` verde; ADR documentando o modelo de ameaças.

**F11.2 Performance**
- Teste de carga (k6): meta inicial de overhead do gateway p95 < 30 ms (sem contar o upstream) a 200 rps numa instância.
- CA: relatório em `docs/perf/`.

**F11.3 Empacotamento e CI/CD**
- Dockerfiles multi-stage (gateway, crawler, admin-ui); `docker-compose.prod.yml` compatível com stack Portainer; GitHub Actions com check, test, build, push de imagem e migrations como job separado.
- CA: deploy do zero numa VPS seguindo `docs/deploy.md`.

**F11.4 Integração com consumidores**
- Guia e exemplo de configuração para o Claude Code/Desktop e para um cliente MCP genérico, via `/mcp` ou `/mcp/omni`.
- CA: um agente em ambiente de dev executa um fluxo usando o gateway.

---

### F12 — Internacionalização (ADR-012)

**F12.1 Pacote `i18n`**
- `packages/i18n` (puro): `Locale` (`en` default, `pt-BR`, `es`), negociação de `Accept-Language`, tradutor com interpolação, plural e select, catálogos tipados por área e formatadores `Intl`.
- CA: catálogo incompleto quebra o typecheck; testes de interpolação, plural, fallback e negociação.

**F12.2 Idioma no perfil do usuário**
- `users.locale`, `Principal.locale`, `GET/PATCH /admin/v1/me` e `locale` na gestão de usuários.
- CA: o usuário troca o próprio idioma e as próximas requests respeitam a escolha.

**F12.3 Mensagens do backend localizadas**
- `GatewayError` com `Message`, renderizado no idioma do request (Admin API e MCP); policy e composição devolvem `Message`; erros de crawl persistidos como chave.
- CA: o mesmo erro sai em en/pt-BR/es conforme o usuário; sem autenticação segue `Accept-Language`.

**F12.4 Superfície MCP localizada**
- Meta-tools, artifact-tools, instructions e sufixos de tools geradas no idioma do principal.

**F12.5 Admin UI**
- Toda string via catálogo, seletor de idioma no header (salvo no perfil), datas e números por locale.
- CA: E2E troca o idioma e verifica a interface e um erro da API.

**F12.6 Código em inglês**
- Mensagens-fonte, logs, comentários e nomes de testes em inglês.

---

### F13 — Importação multiformato (ADR-014)

**F13.1 Pacote `api-import` e cURL**
- `packages/api-import` (puro) converte para OpenAPI 3.1:
  - `detectFormat`, `parseImportText` e `ImportError`;
  - path template heurístico e remoção de credenciais (security scheme e sugestão de credencial, nunca o valor);
  - parser de cURL: tokenizer de shell, vários comandos colados, flags usuais.
- O OAS gerado não leva valores de exemplo.
- CA: fixtures de cURL geram um OAS que passa em `parseSpec`; snapshot das tools; nenhum segredo das fixtures aparece no OAS.

**F13.2 Postman**
- Coleções v2.0 e v2.1:
  - pastas viram tags; variáveis `{{var}}` e `:param` são resolvidas;
  - `auth` é tratado; bodies `raw`, `urlencoded` e `formdata`; exemplos de resposta viram output schema;
  - o envelope `{ collection }` é desembrulhado.
- GraphQL e file são pulados com warning.
- CA: a coleção do upstream fake gera tools cujo input schema valida payloads reais.

**F13.3 HAR**
- HAR 1.2:
  - filtra assets e `OPTIONS`;
  - usa a origem mais frequente (descarta as demais com warning);
  - agrupa por `METHOD` + path template;
  - infere schemas a partir de várias amostras.
- CA: um HAR gravado contra o upstream fake gera as mesmas operações; o ruído é descartado com warning.

**F13.4 Merge de OpenAPI**
- `mergeOpenApi(base, incoming, 'add' | 'replace', include?)` por `METHOD path`, devolvendo `added`, `replaced` e `conflicts`.
- CA: os modos add, replace, conflito e `include` estão cobertos.

**F13.5 Dados e crawler**
- `fetchSpec` sai do crawler para `packages/net`.
- Migration `upstream_sources.spec_format` (`openapi | postman`) e `import_meta`, com o par down.
- O crawler converte coleções Postman obtidas por URL a cada crawl.
- CA: a migration sobe e desce; o crawl de uma URL Postman servida pelo upstream fake gera tools.

**F13.6 Admin API de importação**
- `POST /sources/import/preview` não grava nada.
- `POST /sources/import` cria uma source nova ou faz merge numa source inline e enfileira o crawl.
- `GET /sources/:id/openapi`.
- `bodyLimit` próprio (`IMPORT_MAX_BYTES`), SSRF na URL e o body não é logado.
- CA: contrato publicado; SSRF bloqueado; fim a fim, cURL importado → crawl → `tools/call` via `/mcp` contra o upstream fake.

**F13.7 Admin UI**
- Wizard "Importar API" em três passos:
  1. entrada: colar, arquivo ou URL;
  2. preview: warnings e seleção de operações;
  3. destino: source nova ou existente.
- Substitui o formulário de source; botão "Baixar OpenAPI" no detalhe da source; i18n em en, pt-BR e es.
- CA: E2E colando um cURL → preview → criar → tools aparecem `disabled`.

---

### F14 — Composer em linguagem natural (ADR-015)

Objetivo: o usuário descreve a tool ("resumo do colaborador com escala atual e últimas marcações") e o gateway monta a composta (DAG) com um LLM configurado pelo tenant, mostra o grafo, roda o dry-run e publica como MCP. Tudo com revisão humana.

**F14.1 Configuração de LLM por tenant**
- Tabela `tenant_llm_settings` (provider `anthropic | openai | openai_compatible`, modelo, `base_url`, chave cifrada com a data key do tenant, hint, `json_mode`, limite de gerações por hora), migration 0017 com o par down.
- `LlmSettingsRepo` com `tenantId` explícito; a view nunca traz a chave.
- CA: a coluna não guarda a chave em claro; aad de outro tenant não decifra.

**F14.2 Clientes de LLM**
- `apps/gateway/src/llm`: interface `LlmProvider` (`generate` com saída JSON estruturada, `ping`); Anthropic via SDK oficial (sem ler env); OpenAI e compatíveis via `outboundFetch`.
- Erros mapeados para `GatewayError` com mensagens do catálogo `llm`.
- CA: `base_url` privada bloqueada; corpo da requisição nos dois formatos de JSON mode; nenhum segredo em log.

**F14.3 Admin API de configurações**
- `GET/PUT/DELETE /admin/v1/settings/llm` e `POST /admin/v1/settings/llm/test`. Escrita só para `gateway-admin`; a chave é write-only (`hasApiKey` + hint).
- CA: owner recebe 403 na escrita; a chave nunca sai na resposta nem na auditoria.

**F14.4 Lógica pura do composer**
- `compositeGraph` em `packages/composition` (nós com nível e arestas reais).
- `packages/composer` (puro): catálogo para o prompt (output schema desembrulhado, schemas compactados, descrições truncadas), prompts (system, contexto determinístico, pedido, reparo), schema do envelope da proposta e lint de definições geradas.
- CA: o catálogo é determinístico; uma descrição maliciosa fica dentro do bloco de dados; o lint barra `$eval`/`$pad`, nome existente e tool fora dos candidatos.

**F14.5 Geração**
- `POST /admin/v1/composites/generate` (`{prompt, previous?, refinement?, tools?}`): candidatos por `ToolSearch`, redaction do prompt, ciclo gerar → validar → reparar (máx. 2 reparos), rate limit por tenant e usuário, auditoria `composite.generate` sem o texto do prompt.
- `POST /composites/validate` passa a devolver `graph`.
- CA: com um provider fake, o pedido de resumo do colaborador gera `rh_colaborador_get` → `rh_escalas_list` / `rh_marcacoes_list`; o reparo recebe os erros; sem configuração → `LLM_NOT_CONFIGURED`; CPF do prompt chega mascarado; 429 acima do limite.

**F14.6 Prontidão para publicar**
- `GET /admin/v1/composites/:id/readiness?roles=`: estado dos steps, matriz de acesso tool × role (simulação de política) e virtual servers que incluem a composta.
- CA: sem política o acesso é `deny`; depois de criar a política, `allow`.

**F14.7 Admin UI: Configurações**
- Página `/settings` (admin): provider, modelo, `base_url`, chave (write-only), limite por hora e "Testar conexão"; i18n en/pt-BR/es.

**F14.8 Admin UI: modo linguagem natural no Composer**
- Aba "Linguagem natural": pedido → proposta (explicação, premissas, candidatos, tokens), YAML no editor, grafo com arestas reais (SVG, sem dependência nova), "Refinar" e "Aceitar e salvar rascunho" → dry-run.

**F14.9 Admin UI: assistente de publicação**
- Habilitar a composta e os steps, criar políticas allow para os roles escolhidos (admin) e incluir num virtual server, mostrando o endpoint `/mcp/s/:slug`.
- CA: E2E pedido → grafo → rascunho → dry-run → publicação, com a geração simulada via `page.route`.

---

### F15 — Observabilidade de agentes e analytics (ADR-016, ADR-017, ADR-018)

Objetivo: cada chamada gera um `CallEvent` largo (identidade, tool, decisões, dados, desempenho e tokens), do qual derivam auditoria, métricas, spans e analytics. Em cima dele vêm as visões por público, o explorador de chamadas, o analytics de agente e um MCP de observabilidade. Postgres primeiro, atrás de `CallEventSink`/`AnalyticsStore`.

#### Onda 1 — Base

**F15.1 ADRs e plano**
- ADR-016 (arquitetura), ADR-017 (índice de titulares e captura de debug) e ADR-018 (gráficos); adendos nos ADR-003, 010 e 011; tabelas novas em §3; marco M7.

**F15.2 Pacote `packages/call-analytics` (puro)**
- Tipo `CallEvent` v1 com os campos reservados (`plugins`, `gate`, `taint`, `pinnedVersion`), `uuidv7`, `argsHash` (JSON canônico + HMAC), `estimateTokens`/`descriptorTokens` e o mapeamento de convenções semânticas (`SEMCONV`, `toSpanAttributes`).
- CA: o lint de pureza cobre o pacote; o v7 ordena por tempo e devolve o timestamp; `argsHash` não depende da ordem das chaves.

**F15.3 Propagação de trace e convenções semânticas**
- Entrada: `params._meta.traceparent` > header `traceparent` > raiz nova (`baggage` ignorado); saída: `traceparent` no upstream; opt-out por tenant (`settings.observability.tracePropagation`).
- Spans com `gen_ai.*`, `mcp.*` e `mcp_gateway.*`; os atributos `mcp.tenant`/`mcp.tool`/`mcp.decision` continuam (deprecated). O `callId` volta em `_meta["io.github.leandro-jm.mcp-gateway/call-id"]` (namespace definido no ADR-019).
- CA: o span raiz é filho do `traceparent` recebido; o upstream fake recebe o mesmo trace id; o opt-out desliga; nenhum atributo traz a URL resolvida.

**F15.4 Sessão e agente**
- `mcp-session-id` emitido no `initialize` (`mgs1_…` com o `clientInfo`); `CallContext.identity` com sessão, origem, agente e endpoint; toggle `settings.observability.issueSessionId`.
- CA: o `initialize` devolve o header; a chamada seguinte registra o agente; sem header o comportamento antigo continua; o toggle desliga.

**F15.5 Tabela `call_events`**
- Migration 0018: particionada por dia, partição DEFAULT, função `call_events_ensure_partition`, `overhead_ms` gerado; retenção `CALL_EVENTS_RETENTION_DAYS`.
- `CallEventWriter` (`@cross-tenant`, só insert em lote) e `CallEventsRepo` (`tenantId` explícito).
- CA: migration up/down/up; partições criadas à frente e descartadas fora da retenção.

**F15.6 Sink em lote**
- `BatchingCallEventSink` (flush por tempo ou tamanho, um flush por vez, teto do buffer com descarte contado, `close()` com flush) e `MemoryCallEventSink` para testes.
- CA: testes unitários de flush por tamanho/tempo, overflow, falha e fechamento.

**F15.7 O executor monta um único `CallEvent`**
- `CallRecorder` com tempos por etapa; audit, métricas e span derivados do evento; persistir o que hoje se perde (ruleId do allow, trace do deny, detokenize, attempts, latência do upstream, bytes da projeção, tokens).
- Eventos também para steps de compostas, artifact tools, `search_tools`/`get_tool_schema` (sem o texto da query) e `tools/list`.
- CA: uma chamada gera um evento; as etapas somam no máximo a latência total; nenhum campo de `call_events` contém PII em claro (varredura com os detectores da F5); os testes de auditoria e observabilidade existentes continuam verdes.

**F15.8 Rollups**
- `call_rollups_hourly`, `usage_rollups_daily` e `analytics_watermarks`, mantidos pelo job de manutenção com advisory lock e watermark (idempotente).
- CA: os totais batem com os eventos brutos; rodar duas vezes dá o mesmo resultado; evento atrasado entra no bucket certo.

**F15.9 DSL e `AnalyticsStore`**
- `AnalyticsQuery` tipada (métricas e dimensões em whitelist, ≤ 2 `groupBy`, ≤ 90 dias, `limit` ≤ 100), compilada para SQL com bind; `POST /admin/v1/analytics/query`; papel `analytics-reader`.
- CA: chaves desconhecidas e intervalos grandes são rejeitados com mensagem localizada; texto malicioso vira só parâmetro; agente recebe 403.

**F15.10 Métricas de SRE e alertas**
- Métricas por etapa, overhead do gateway, erros por etapa, tokens economizados e circuit breaker aberto; `docs/observability/prometheus-rules.yml` com alertas de burn rate.
- CA: as regras só referenciam métricas existentes (teste).

#### Onda 2 — Visões, explorador e MCP de observabilidade

**F15.11 Índice de titulares (LGPD)**
- Fingerprints HMAC normalizados coletados no redaction e nos argumentos; tabela `call_subject_refs`; `POST /admin/v1/lgpd/subject-access` (admin, auditado sem o valor).
- CA: CPF com e sem máscara dá o mesmo fingerprint; outro tenant dá outro; a consulta encontra a chamada depois da retenção do `call_events`; owner recebe 403.

**F15.12 Visões por público**
- `GET /admin/v1/analytics/{sre,tools,security,finops}` e `GET /admin/v1/platform/usage`: overhead × upstream, erros por source e etapa, uso por agente, tools nunca usadas, impacto de drift, negações, redactions por detector, anomalias de volume, tokens economizados em moeda (`settings.observability.pricing`) e chargeback.
- CA: números iguais aos fixtures; owner vê só as próprias tools; matriz de papéis.

**F15.13 API do explorador e explain**
- `GET /admin/v1/calls` e `GET /admin/v1/calls/:callId` (etapas, regra de política com trace, redactions, corte da projeção, filhas, `policyChanged` re-simulando a política atual).
- CA: um deny mostra a regra e o trace; uma chamada antiga mostra `policyChanged` após mudança de política.

**F15.14 MCP de observabilidade**
- `POST /mcp/observability` com `analytics_query`, `explain_call` e `top_failing_tools` (`outputSchema` + `structuredContent`), para `gateway-admin` e `analytics-reader`.
- CA: owner e agente recebem 403; os resultados batem com a Admin API; DSL inválida devolve erro localizado; isolamento de tenant.

**F15.15 Primitivas de gráfico (ADR-018)**
- SVG inline sobre os tokens do tema, acessíveis e sem dependência nova.

**F15.16 Página de observabilidade**
- `/observability` com abas SRE, Tools, Security (LGPD só para admin) e FinOps; configurações de observabilidade em `/settings`; card de conexão do MCP de observabilidade.
- CA: E2E das abas e da troca de idioma; owner vê só Tools.

#### Onda 3 — Debug

**F15.17 Captura de debug**
- Captura opt-in (motivo, filtro, teto, prazo), conteúdo cifrado no S3 com TTL; `GET /admin/v1/calls/:callId/debug` (admin, auditado).
- CA: só chamadas do filtro, até o teto; o objeto no MinIO não contém o CPF; owner recebe 403; desligado sem S3 ou com o kill switch.

**F15.18 Replay-mock**
- `POST /admin/v1/calls/:callId/replay` re-executa o pipeline sobre a resposta gravada com a configuração atual.
- CA: mudar a projeção muda o replay; o upstream não é chamado; auditoria `tools/replay`.

**F15.19 UI do explorador**
- `/calls` com waterfall, trace da política, filhas, diff bruto × final e replay (admin); link a partir da auditoria.

#### Onda 4 — Analytics de agente

**F15.20 Algoritmos (puros)**
- Sessionização, loops, thrash, busca seguida de escolha errada, abandono, mineração de sequências e transições; esqueleto de composta a partir de uma sequência.
- CA: testes com fixtures; o esqueleto passa no `parseComposite`.

**F15.21 Job de analytics de agente**
- `agent_findings`, `tool_transitions_daily`, `composite_suggestions` e `call_outcomes`; job a cada 15 min com lock e watermark.
- CA: sessões com loop e sequência frequente geram finding e sugestão; rodar de novo não duplica; sugestão descartada não reabre.

**F15.22 `report_outcome`**
- Meta-tool (`settings.observability.outcomeTool`) e `POST /v1/outcomes`; vinculação por `call_ids` ou janela da sessão; taxa de sucesso na DSL e no `top_failing_tools`.
- CA: `call_ids` de outro subject são rejeitados; `off` esconde a tool.

**F15.23 API de agentes**
- Sessões e trajetórias, findings, sugestões (aceitar cria composta `draft`/`disabled`), co-uso e outcomes.
- CA: aceitar cria a composta desabilitada com a checagem de owner e auditoria; isolamento de tenant.

**F15.24 UI de sessões e agentes**
- `/sessions` (timeline e replay da trajetória) e `/agents` (findings, sugestões, grafo de co-uso, taxa de sucesso).
- CA: E2E aceitando uma sugestão e abrindo o rascunho no Composer.

#### Onda 5 — Fechamento

**F15.25 Hardening e documentação**
- Suíte de segurança cobrindo as rotas novas, varredura de PII nas tabelas novas, k6 (overhead p95 até +2 ms em relação à F11.2), guia em `docs/observability/`.

---

## 5. Ordem e marcos

| Marco | Fases | Resultado |
|---|---|---|
| M1 — Gateway funcional | F0–F3 | Agente chama APIs REST via MCP, com tools geradas automaticamente |
| M2 — Seguro para dados de RH | F4–F5 | Authz por tool + PII redaction; pronto para piloto com 1 cliente |
| M3 — Eficiente em contexto | F6–F8 (inclui F7b) | Projeção, Omni, composição de tools, MCPs self-service e artefatos |
| M4 — Operável | F9–F11 | Auditoria, UI do owner, deploy e integração |
| M5 — Onboarding sem OpenAPI | F13 | Sources criadas a partir de cURL, Postman ou HAR, com preview |
| M6 — Composição assistida | F14 | Compostas criadas a partir de linguagem natural, revisadas e publicadas pela UI |
| M7 — Agentes observáveis | F15 | Evento largo por chamada, visões por público, explorador, trajetórias, sugestão de compostas e MCP de observabilidade |

M2 é o mínimo para qualquer uso com dados reais de clientes.

---

## 6. Requisitos não funcionais

- Isolamento multi-tenant obrigatório em todas as queries (repositórios recebem `tenantId` explícito; teste de lint/arquitetura impede query sem tenant).
- Nada de PII ou credencial em logs (logger com redaction de chaves sensíveis).
- Toda configuração de comportamento (políticas, PII, projeção) aplicável sem deploy.
- Compatível com a versão estável vigente da spec MCP suportada pelo SDK oficial; registrar a versão em ADR.

---

## 7. Fora do escopo da v1

- Upstreams gRPC/Protobuf e federação de servidores MCP nativos.
- Schema canônico de RH (camada de tools padronizadas entre ERPs).
- Marketplace de servidores de parceiros.
- Compostas recursivas (composta chamando composta) e compensação/saga para composições com escrita.

## 8. Extension points já previstos

- `UpstreamAdapter` (interface) no tradutor: REST hoje; `GrpcAdapter` (via reflection) e `McpUpstreamAdapter` (federação com heartbeat) depois.
- `SourceDiscoverer` no crawler: OpenAPI hoje; Protobuf e MCP heartbeat depois.
- `ToolNamespace` canônico: permitir que uma tool canônica (`rh.colaborador.buscar`) aponte para implementações diferentes por tenant, o que é a base do schema de RH.

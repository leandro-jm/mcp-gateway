# ADR-003: Modelo de ameaças

- Status: aceito
- Data: 2026-10-03

## Contexto
O gateway fica entre agentes de IA, que são clientes semiconfiáveis sujeitos a prompt injection, e APIs de RH com dados pessoais e sensíveis de vários clientes (tenants). A F11.1 pede uma suíte de segurança e o registro do modelo de ameaças.

## Ativos
1. Dados pessoais (CPF, salário, saúde etc.) que trafegam nas respostas.
2. Credenciais dos upstreams (client secrets, API keys, tokens OAuth).
3. Fronteira entre tenants.
4. Rede interna onde o gateway roda (metadata da nuvem, serviços internos).
5. Integridade das operações de escrita (marcações, exclusões).

## Atores
- **Agente comprometido ou manipulado (prompt injection)**: controla nome de tool e argumentos.
- **Usuário de outro tenant**: possui um token válido emitido pelo gateway.
- **Owner malicioso ou descuidado**: controla specs, overrides, tools manuais, compostas e políticas do seu time.
- **Upstream comprometido ou malicioso**: controla respostas, headers e redirects.

## Ameaças e mitigações (STRIDE resumido)
| # | Ameaça | Mitigação | Teste |
|---|---|---|---|
| T1 | **SSRF**: base URL, spec, token URL ou webhook apontando para rede interna ou metadata | `outboundFetch` (`packages/net`) em todo tráfego de saída. Bloqueia protocolos ≠ http(s), credenciais na URL, `localhost`/`*.internal`, IP literal privado, inclusive IPv4 embutido em IPv6 (`::ffff:a9fe:a9fe`, NAT64, 6to4), checado na URL e de novo no connector (IP literal não passa pelo `lookup`), e **IPs privados resolvidos na conexão** (anti DNS rebinding). Allowlist de hosts por tenant. `NETWORK_ALLOW_PRIVATE=false` em produção; o tenant só restringe. Redirects não são seguidos. A Admin API valida as URLs na escrita. | `security/ssrf`, `network.test` |
| T2 | **Injeção em path params** (`../`, `%2e%2e`) para alcançar outro recurso | `encodeURIComponent` por segmento. Valores com segmento `.`/`..` (inclusive entre barras, para upstreams que decodificam `%2F`) e caracteres de controle são rejeitados. O path final precisa ter a mesma forma do template. | `security/injection-headers`, `request-builder.test` |
| T3 | **Injeção em headers/query** (CRLF, `&`) | Valores de header com CR/LF são rejeitados. A query é montada por `URLSearchParams`. `additionalProperties: false` nos inputs. | `security/injection-headers` |
| T4 | **Vazamento do token do agente ao upstream** | O tradutor monta a requisição só a partir do mapping da tool e da credencial da source. Nenhum header do cliente MCP é repassado. | `security/injection-headers` |
| T5 | **Vazamento de headers ou credenciais do upstream ao agente** | O resultado contém só o corpo (já redigido), do qual os valores aplicados pela credencial (header e query, também URL-encoded) são removidos. Headers do upstream nunca são devolvidos. Credenciais ficam cifradas (AES-256-GCM, data key por tenant, AAD por registro) e nunca aparecem em respostas ou logs. Tokens OAuth no Redis também são cifrados. | `credentials.int`, `admin-api.int`, `logger.test`, `rest-adapter-secrets.test` |
| T6 | **Quebra de isolamento entre tenants** | Tenant derivado do usuário dono do token (ADR-011), com `X-Tenant` divergente → 401. Só o admin de plataforma troca de tenant na Admin API; o admin de tenant fica no próprio (adendo ao ADR-008). Repositórios exigem `tenantId` (teste de arquitetura). Snapshots, artefatos, tokens de PII e data keys são por tenant (AAD inclui o tenant). Owners não trocam de tenant. | `security/tenant-isolation`, `security/privilege-escalation`, `architecture.test` |
| T7 | **Escalada via tool composta** (permissão na composta, sem permissão nos steps) | Authz por step com a identidade de quem chamou. `destructiveHint` é herdado e exige allow explícito, por nome ou padrão com prefixo literal. Limites de steps, chamadas e bytes, e rate limit por tool em cada step. Playground e dry-run: owners só nas próprias tools, sem simular `gateway-admin`, sem escrita, e a auditoria mantém a identidade real. | `composites.int`, `security/privilege-escalation` |
| T8 | **Exfiltração de PII pelo modelo** | Redaction antes de qualquer byte chegar ao modelo, incluindo mensagens de erro (também de steps de compostas), artefatos e dry-run para não-admin. Nomes sensíveis cobrem valores aninhados. Tokens de PII são reversíveis só no gateway, no mesmo tenant, para o mesmo subject que os recebeu e em campos compatíveis. O preview de regras usa chave descartável. Artefatos ficam presos ao `sub` além da sessão. A auditoria é sanitizada. | `pii.int`, `audit.int` |
| T9 | **Abuso / DoS** | Rate limit por tenant, client, tool e obrigação de política (também em `artifact_query` e nos steps de compostas). Limites de tamanho de request e response, com teto nas settings do tenant e leitura limitada também nos endpoints de token. Circuit breaker por source. Timeouts. Limite de fan-out em compostas. Sessões Omni com teto por subject e total. Login com limite por usuário além de usuário+IP, e `TRUST_PROXY` explícito. | `credentials-guards.int`, `security/privilege-escalation` |
| T10 | **Tool nova ou alterada exposta sem revisão** | Default deny. Tools nascem `disabled`. Mudança breaking volta a `disabled` e cascateia para as compostas. Drift notifica o owner. | `register.int`, `webhooks.int` |
| T11 | **Spec maliciosa** (`$ref` externo, YAML bomb, spec gigante) | `$ref` externo é rejeitado. Tamanho expandido das referências limitado antes de desreferenciar (fan-out exponencial). Limite de aliases no YAML. Limite de bytes e timeout no download. | `normalize.test` |
| T12 | **Expressões de usuário (JSONata/regex) custosas** | JSONata com os guardrails nativos (timeout, profundidade, tamanho de sequência), pois `setTimeout` não interrompe o JSONata. `artifact_query` roda num processo filho descartável com teto de heap (ADR-013). Regex configuráveis (policies, conta bancária do tenant) passam por validação anti-ReDoS na escrita e na execução, e o detector de e-mail é linear. | `composition.test`, `artifacts.int`, `jsonata-sandbox.test`, `regex.test`, `detectors.test` |
| T13 | **Vazamento pela observabilidade** (eventos de chamada, índice de titulares, captura de debug, MCP de observabilidade) | `call_events` guarda só contagens, hashes e nomes, nunca payload, query de busca ou texto livre; subject e client são sanitizados com a chave PII do tenant. O índice LGPD guarda HMAC normalizado com chave derivada por tenant e é consultado só por `gateway-admin`, com auditoria sem o valor (ADR-017). A captura de debug é opt-in, com motivo, prazo e teto, fica cifrada com a data key do tenant e expira em 24 h. O MCP de observabilidade exige `gateway-admin` ou `analytics-reader`, aceita só a DSL tipada (sem SQL) e nunca devolve payload. `baggage` recebido é ignorado. | `call-events.int`, `subject-index.int`, `debug-capture.int`, `observability-mcp.int`, `security/tenant-isolation` |

## Riscos aceitos
- Sessões do modo Omni dinâmico ficam em memória (exigem afinidade). Não há risco de confidencialidade, só de disponibilidade, limitada pelos tetos de sessões.
- O admin de plataforma (`gateway-admin` sem tenant) enxerga todos os tenants via `X-Tenant`. É um papel operacional e deve ser concedido com parcimônia.
- Expressões JSONata de compostas rodam no processo do gateway, só com os guardrails nativos. Uma função nativa cara escrita por um owner ainda pode custar CPU/memória (ADR-013).
- A negação de policy devolve ao agente a regra e a condição não atendida. Isso ajuda o agente a corrigir a chamada, ao custo de expor nomes de regras e padrões.
- scrypt das senhas segue com N=2^14: subir para 2^17 custaria 128 MB por login num endpoint público.
- Webhooks de drift não incluem timestamp na assinatura (replay) e o segredo fica nas settings do tenant.
- O índice de titulares (ADR-017) é pseudonimização e continua sendo dado pessoal; quem tem a data key do tenant confirma a presença de um CPF candidato.
- Eventos de analytics podem ser descartados sob pressão (buffer cheio); a auditoria continua síncrona (ADR-016).

## Revisão (pentest de 2026-10-03)
O pentest encontrou controles que não se sustentavam:
- **T1**: o filtro de IP privado não reconhecia IPv4 embutido em IPv6, e IP literal não passava pelo `lookup`.
- **T7**: owners executavam tools reais como subject forjado no playground e no dry-run.
- **T9**: login burlável via `X-Forwarded-For`.
- **T12**: o timeout de JSONata não disparava.

Os itens acima foram corrigidos, e a suíte `security/` cobre os PoCs.

## Consequências
A suíte `pnpm test:security` (`apps/gateway/test/security`) roda na CI. Qualquer nova saída de rede deve usar `outboundFetch`.

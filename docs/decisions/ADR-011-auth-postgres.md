# ADR-011: Autenticação própria com usuários e tokens no Postgres

- Status: aceito
- Data: 2026-10-03

## Contexto
A autenticação dependia de um IdP externo: JWT validado pelas chaves públicas do IdP, login da Admin UI por Authorization Code + PKCE e um IdP de desenvolvimento no compose. O custo era alto para o projeto: um container a mais, uma configuração de IdP para manter, claims customizadas (`tenant`, `groups`) e um fluxo OAuth que os agentes de máquina não usam. O objetivo é simplificar sem mudar o modelo de autorização (policies, owners por grupo, isolamento por tenant).

## Decisão
- **Identidades no Postgres.**
  - `users`: `username` é único global e imutável e vira o `sub`. Os demais campos são `tenant_id`, `kind`, `password_hash`, `roles`, `groups`, `attributes` e `status`.
  - `kind = human` tem senha e entra na Admin UI. `kind = service` é um agente: não tem senha e só usa tokens.
  - `attributes` (jsonb) substitui as claims customizadas usadas nas condições de policy (`claims.unidades` etc.).
  - `tenant_id` nulo indica **admin de plataforma**. Um CHECK exige a role `gateway-admin` nesse caso. O admin de plataforma escolhe o tenant pelo header `X-Tenant`.
- **Tokens opacos.**
  - Formato: `mgw_<32 bytes base64url>`. O banco guarda só o SHA-256 (`api_tokens.token_hash`) e um prefixo para exibição. O valor aparece uma única vez, na criação.
  - O token pertence a um usuário e herda roles, grupos e atributos dele. O `name` do token vira o `clientId`, usado em policies `client` e no rate limit.
  - Há dois tipos de token:
    - `session`: emitido em `POST /admin/v1/auth/login`, expira em `AUTH_SESSION_TTL_HOURS` e é revogado no logout;
    - `api`: criado na Admin API, com expiração opcional.
- **Verificação.** O verificador consulta o banco (`AuthQueries.findActiveToken`) e guarda o resultado num cache em memória de 15 s, incluindo os negativos. A revogação vale imediatamente na réplica que revogou e em até 15 s nas demais. `last_used_at` é atualizado no máximo uma vez por minuto por token.
- **Senhas.** `scrypt` do `node:crypto` (sem dependência nova), com salt aleatório, no formato `scrypt$N$r$p$salt$hash`, comparadas com `timingSafeEqual`.
- **Login.** Rate limit por username + IP usando o `RateLimiter` existente. A mensagem de erro é genérica.
- **Clientes MCP.** Usam `Authorization: Bearer <token>` estático. O Protected Resource Metadata (RFC 9728) e o fluxo OAuth dos clientes MCP saem. O `WWW-Authenticate` continua com `Bearer realm="mcp-gateway"`.
- **Contrato interno inalterado.** O `Principal { sub, tenant, roles, groups, clientId, claims }` continua igual. Policies, auditoria, rate limit e regras de owner não mudam.
- **Bootstrap.**
  - Dev: `pnpm db:seed` cria `admin/admin` (plataforma), `owner/owner`, `agente/agente` e o usuário service `agent-dev` com um token fixo.
  - Produção: `pnpm db:create-admin <username>` cria um admin de plataforma e imprime a senha gerada.

## Consequências
- Um serviço a menos no stack. A gestão de usuários passa a ser feita na Admin UI (páginas Usuários e Tokens).
- Cada request autenticada faz uma consulta indexada ao banco, amortizada pelo cache.
- Não há SSO nem login OAuth automático em clientes MCP. Se for preciso, um IdP pode voltar só para o login humano, emitindo tokens de sessão deste mesmo modelo.

## Adendo (F15, ADR-016)
Papel novo `analytics-reader`: leitura de analytics (`/admin/v1/analytics/*`, explorador de chamadas sem payload) e acesso ao MCP de observabilidade (`/mcp/observability`). Não dá acesso ao índice LGPD nem à captura de debug, que ficam com `gateway-admin`.

# ADR-030: OAuth 2.1 para clientes MCP e login federado (OIDC)

- Status: proposto
- Data: 2026-11-06
- Revisa: ADR-011
- Depende de: ADR-003, ADR-012, ADR-016, ADR-021, ADR-022

## Contexto
O ADR-011 tirou o IdP externo e o fluxo OAuth dos clientes MCP. Desde então, todo cliente usa `Authorization: Bearer mgw_…` estático, e o próprio ADR-011 registrou a consequência: não há SSO nem login OAuth automático em clientes MCP.

Essa consequência virou bloqueio de adoção:
- **Clientes que só falam OAuth não conectam.** Conectores remotos do Claude.ai e do Claude Desktop, o ChatGPT e vários IDEs descobrem o Authorization Server pelo `WWW-Authenticate` e não oferecem campo para header fixo.
- **O usuário humano copia token na mão.** Ele cria um token em "Meus tokens", cola no cliente e lembra de revogar. Não há tela de consentimento nem lista de aplicativos conectados.
- **Não há SSO.** Empresas que exigem login pelo IdP corporativo (Entra, Okta, Google) não conseguem usar a Admin UI nem os clientes MCP com a identidade delas. No comparativo com produtos de mercado (Runlayer), essa é a lacuna mais visível.

A spec MCP 2026-07-28 (ADR-021) define a autorização de servidores HTTP:
- OAuth 2.1 com Authorization Code e PKCE `S256`;
- Protected Resource Metadata (RFC 9728) obrigatório no servidor MCP, anunciado no `WWW-Authenticate` por `resource_metadata`;
- metadata do Authorization Server (RFC 8414 ou OpenID Discovery);
- resource indicators (RFC 8707) em todo pedido de autorização e de token;
- parâmetro `iss` na resposta de autorização (RFC 9207), e credenciais de cliente presas ao issuer que as emitiu (SEP-2352);
- registro de cliente por **Client ID Metadata Documents (CIMD)** como mecanismo principal. O Dynamic Client Registration (RFC 7591) fica **depreciado**, mantido por compatibilidade com remoção prevista em revisão futura, e ganha `application_type` para clientes nativos com redirect em loopback (SEP-837).

O modelo de tokens do ADR-011 (opaco, SHA-256 no banco, cache de 15 s, `Principal` estável) funciona bem e é a base de policies, rate limit e `CallEvent`. A decisão precisa trazer o OAuth sem trocar esse modelo e sem trazer de volta o custo que o ADR-011 removeu (um IdP obrigatório no stack).

## Decisão

### Papel do gateway
- O gateway é **resource server e Authorization Server** no mesmo origin. O `issuer` é o `PUBLIC_URL`.
- Os tokens emitidos pelo fluxo OAuth são **tokens opacos do modelo do ADR-011**. O `TokenVerifier` continua sendo o único caminho de verificação, e policies, rate limit, auditoria e `CallEvent` não mudam de modelo.
- O IdP externo volta **só para o login humano** (fase B), como o ADR-011 já previa. Ele autentica a pessoa; quem emite o token é sempre o gateway.
- A entrega tem duas fases:
  - **A**: Authorization Server com login por senha local;
  - **B**: login federado por OIDC, por tenant, que também vale para a Admin UI.

### Liga/desliga
Há três chaves, e todas precisam estar ligadas para um cliente obter token:

| Chave | Padrão | Efeito quando desligada |
|---|---|---|
| Plataforma: `OAUTH_ENABLED` | `false` | Nenhuma rota OAuth existe. Well-known dá 404, e o `WWW-Authenticate` fica igual ao de hoje |
| Tenant: `settings.oauth.enabled` | `false` | Usuários do tenant não concluem o login OAuth (mensagem localizada na tela) |
| Tenant: `settings.oauth.clients` | `allowlist` vazia | `any` aceita qualquer cliente, com consentimento; `allowlist` aceita só os `client_id` (ou hosts de CIMD) listados |

Em produção, `assertProductionConfig` recusa `OAUTH_ENABLED=true` quando o `PUBLIC_URL` não é HTTPS.

Tokens estáticos (`kind = api`) continuam funcionando em qualquer combinação. O OAuth é um caminho a mais, não um substituto.

### Endpoints
As rotas ficam num plugin raiz (`apps/gateway/src/oauth/`), fora do hook `adminAuth` da Admin API.

| Rota | Função |
|---|---|
| `GET /.well-known/oauth-protected-resource[/<path MCP>]` | PRM (RFC 9728) de cada superfície MCP (`/mcp`, `/mcp/omni`, `/mcp/s/:slug[/omni]`, `/mcp/observability`): `resource`, `authorization_servers: [PUBLIC_URL]`, `scopes_supported` |
| `GET /.well-known/oauth-authorization-server` | Metadata RFC 8414: endpoints, `response_types_supported: [code]`, `grant_types_supported: [authorization_code, refresh_token]`, `code_challenge_methods_supported: [S256]`, `token_endpoint_auth_methods_supported: [none]`, `client_id_metadata_document_supported: true`, `authorization_response_iss_parameter_supported: true`, `registration_endpoint` só com DCR ligado |
| `GET /oauth/authorize` | Valida o pedido e mostra a tela de login |
| `POST /oauth/authorize/login` | Login (senha; na fase B, também o início do SSO) |
| `POST /oauth/authorize/consent` | Aprova ou nega e redireciona ao cliente |
| `POST /oauth/token` | `authorization_code` e `refresh_token` |
| `POST /oauth/revoke` | Revogação (RFC 7009) |
| `POST /oauth/register` | DCR (RFC 7591), atrás de `OAUTH_DCR_ENABLED` (padrão `true` quando o OAuth está ligado) |
| `GET /oauth/sso/start`, `GET /oauth/sso/callback` | Fase B: login no IdP do tenant |

- O `WWW-Authenticate` das superfícies MCP passa a incluir `resource_metadata="<PRM da superfície>"` e `scope="mcp"` quando o OAuth está ligado. O `realm="mcp-gateway"` continua.
- Respostas de token, register e revoke seguem o formato de erro do RFC 6749 (`error`, `error_description`), com `Cache-Control: no-store`. O `error_description` vem do catálogo i18n.
- Well-known, token, register e revoke respondem CORS com `Access-Control-Allow-Origin: *` e sem credenciais, para clientes que rodam no navegador (MCP Inspector). As telas de authorize não têm CORS.
- O nginx da Admin UI e o proxy do Vite passam a encaminhar `/.well-known/oauth-` e `/oauth/` ao gateway, ao lado de `/admin`, `/mcp` e `/sdk`.

### Registro de clientes
- **Só clientes públicos.** `token_endpoint_auth_method` é sempre `none` e a prova de posse é o PKCE. Não há client secret nesta versão.
- **CIMD (principal).**
  - O `client_id` é uma URL HTTPS. O gateway busca o documento com `outboundFetch` e `readLimited` (T1 do ADR-003), com teto de 5 KB e sem seguir redirects.
  - O documento precisa ter `client_id` igual à URL, `redirect_uris` e `client_name`. O resto é ignorado.
  - O documento fica em cache no Redis, respeitando `Cache-Control`, com teto de 24 h. Um `client_id` desabilitado pela plataforma é recusado antes da busca.
- **DCR (compatibilidade).**
  - O gateway gera um `client_id` aleatório e guarda os metadados em `oauth_clients`.
  - `application_type: native` aceita redirect em loopback (`127.0.0.1`, `[::1]`, `localhost`); `web` exige HTTPS.
  - O registro tem rate limit por IP. Clientes DCR não usados em 30 dias são removidos.
- **Pré-registro** (client_id e secret cadastrados pelo admin) fica fora desta versão.
- **Redirect URI.** O casamento é exato, exceto a porta em loopback, que pode variar (RFC 8252 §7.3).

### Identidade do cliente e policies
- Tokens OAuth geram `Principal.clientId`:
  - `oauth:<host do client_id>` para CIMD (por exemplo, `oauth:claude.ai`). O host é verificável, porque o documento foi servido por ele;
  - `oauth:dcr:<client_id>` para DCR. O `client_name` é autodeclarado e só aparece na tela de consentimento e na Admin UI.
- Policies com `subject_type = client` e o rate limit por client passam a casar com esses valores. O `CallEvent` registra o `clientId` como hoje (ADR-016).
- O restante do `Principal` vem do usuário que autorizou: `sub`, tenant, roles, grupos, atributos e locale. O token OAuth age **em nome do usuário humano**, com as mesmas permissões que ele teria com um token próprio.

### Tokens e grants
- **Código de autorização:**
  - uso único, `OAUTH_CODE_TTL_SECONDS` (60 s), só o hash no banco;
  - preso a cliente, usuário, `redirect_uri`, `code_challenge` e `resource`;
  - um código reutilizado revoga o grant que ele gerou (RFC 9700 §4.5).
- **Grant (`oauth_grants`):**
  - o vínculo usuário × cliente com escopos, `resource` e uma família de refresh tokens;
  - é o que aparece em "Aplicativos conectados", e revogar o grant revoga todos os tokens dele.
- **Access token:**
  - linha em `api_tokens` com `kind = oauth` e `grant_id`, formato `mgw_…`, expira em `OAUTH_ACCESS_TTL_MINUTES` (60 min) ou no valor menor do tenant;
  - a revogação segue o ADR-011: imediata na réplica que revogou e em até 15 s nas demais.
- **Refresh token:**
  - só com o escopo `offline_access`. Formato `mgr_<32 bytes base64url>`, só o hash, em `oauth_refresh_tokens` ligado ao grant. O já rotacionado fica guardado até expirar, para detectar reuso;
  - rotaciona a cada uso e expira em `OAUTH_REFRESH_TTL_DAYS` (30 dias) ou no valor menor do tenant;
  - um refresh já rotacionado que volta a ser usado revoga a família inteira e invalida o cache do verificador.
- **Audiência (RFC 8707).**
  - O `resource` precisa começar com o `PUBLIC_URL` e ser uma das superfícies MCP. Qualquer outro valor dá `invalid_target`.
  - O token vale em todas as superfícies MCP do gateway; a autorização fina continua nas policies, como com tokens estáticos.
- **Fronteira com a Admin API.** Tokens `kind = oauth` são recusados no `adminAuth`. O fluxo OAuth dá acesso ao data plane, não à administração.
- **Desativação.** Usuário desabilitado, tenant suspenso ou `settings.oauth.enabled = false` invalidam os tokens na próxima verificação, pelas checagens do verificador. Desligar o OAuth do tenant também recusa refresh.

### Escopos
- `mcp`: acesso ao data plane com as permissões do usuário.
- `offline_access`: emite refresh token.
- Escopos desconhecidos são ignorados, e os concedidos voltam na resposta de token.
- Escopos por superfície ou por tool ficam fora desta versão: a autoridade de acesso continua sendo a policy (default deny).

### Login e consentimento
- As telas são **HTML mínimo servido pelo gateway**, sem a Admin UI. Elas funcionam com o gateway publicado sozinho e ficam no mesmo origin do `issuer`.
  - As strings vêm do catálogo `oauth` do servidor, nos três locales (ADR-012), escolhidos por `Accept-Language`.
  - Cabeçalhos: CSP estrita (sem script inline de terceiros, `form-action 'self'`), `frame-ancestors 'none'`, `Cache-Control: no-store` e `Referrer-Policy: no-referrer`.
- **Pedido pendente.**
  - `GET /oauth/authorize` valida cliente, redirect, `response_type`, PKCE e `resource`.
  - Erro antes de o redirect estar validado mostra uma página de erro e **nunca redireciona** (sem redirect aberto). Erro depois disso redireciona com `error`, `state` e `iss`.
  - O pedido válido fica no Redis (`oauth:req:<id>`, 10 min) com um token CSRF aleatório. Os POSTs de login e consentimento exigem esse token.
- **Login por senha.**
  - O gateway extrai a lógica do `POST /admin/v1/auth/login` para um helper compartilhado: rate limit por usuário + IP e por usuário, `DUMMY_HASH` contra enumeração por tempo, só humanos ativos de tenant ativo, mensagem genérica.
  - O OAuth exige ainda `settings.oauth.enabled` no tenant do usuário e o cliente permitido pela allowlist dele.
  - Admin de plataforma (sem tenant) não conclui o fluxo, porque o data plane exige tenant (`mcp.userWithoutTenant`).
- **Consentimento.**
  - A tela mostra o `client_name`, o host do `client_id`, o host do redirect, os escopos e avisos: redirect em loopback ("um programa neste computador") e cliente DCR ("identidade não verificada").
  - Aprovar cria ou atualiza o grant, emite o código e redireciona com `code`, `state` e `iss`.
  - Um grant ativo do mesmo usuário e cliente que já cobre os escopos pedidos dispensa a tela.

### Fase B: login federado (OIDC)
- **Configuração por tenant** (`tenant_identity_providers`):
  - issuer, `client_id`, client secret cifrado com a data key do tenant (AAD com tenant e registro), escopos e `domains[]` para descobrir o tenant pelo e-mail;
  - mapeamento de claims (username, e-mail, grupos), `jit_enabled`, `default_roles` e `require_sso`.
  - Um IdP por tenant nesta versão.
- **Biblioteca:** `openid-client` no gateway, com o `fetch` trocado por `outboundFetch` para que discovery, JWKS e token passem pela proteção SSRF.
- **Fluxo:**
  - a tela de login ganha "Continuar com SSO", que pede o e-mail e encontra o tenant pelo domínio;
  - `/oauth/sso/start` faz Authorization Code com PKCE, `state` e `nonce` contra o IdP;
  - `/oauth/sso/callback` valida o `id_token` (issuer, audiência, `nonce`, expiração) e retoma o pedido pendente: consentimento no fluxo OAuth, ou sessão na Admin UI.
- **Resolução do usuário**, nesta ordem:
  1. vínculo `(issuer, sub)` em `user_identities`;
  2. usuário humano existente do mesmo tenant com o mesmo e-mail, **só com `email_verified = true`**, que ganha o vínculo;
  3. criação JIT, se `jit_enabled` (humano, sem senha, `default_roles`, grupos da claim mapeada);
  4. senão, recusa com mensagem localizada.
- **Sincronização de grupos:** opcional por tenant. Quando ligada, os grupos do usuário são trocados pelos da claim a cada login. Roles nunca vêm do IdP; só `default_roles` na criação JIT.
- **`require_sso`:** desliga o login por senha dos humanos do tenant, na Admin UI e no OAuth. Admins de plataforma não pertencem a tenant e continuam com senha.
- **Admin UI:**
  - o botão SSO da tela de login chama `/oauth/sso/start?return=admin-ui`;
  - o callback devolve um código de uso único (Redis, 60 s), que a SPA troca em `POST /admin/v1/auth/sso/exchange` por um token `kind = session`, idêntico ao do login por senha. A sessão continua em `sessionStorage`.

### Persistência
- Migration 0026 (fase A):
  - `oauth_clients`, `oauth_grants`, `oauth_authorization_codes` (ligados ao grant) e `oauth_refresh_tokens`;
  - `api_token_kind` ganha `oauth`;
  - `api_tokens.grant_id` com FK em cascata.
- Migration 0027 (fase B): `tenant_identity_providers` e `user_identities`.
- Clientes, códigos e refresh tokens são resolvidos antes de se conhecer o tenant, então o repositório de consulta é `@cross-tenant` (como `AuthQueries`). Listagem e revogação de grants, configuração de IdP e vínculos ficam em repositórios com `tenantId` explícito.

### Observabilidade e auditoria
- Eventos de auditoria: grant criado, renovado e revogado, código reutilizado, reuso de refresh (família revogada), login SSO, usuário criado por JIT e vínculo criado. Nenhum código, token, `state` ou `nonce` aparece em log, auditoria ou `CallEvent`.
- Métricas `mcp_oauth_*`: autorizações por resultado, tokens emitidos por grant type, falhas por motivo e latência do fetch de CIMD e do IdP.

### Admin API e UI
- `/settings/oauth` (admin do tenant).
- `/oauth/grants`: o admin do tenant lista e revoga.
- `/me/oauth/grants`: "Aplicativos conectados", o usuário vê e revoga os próprios.
- `/platform/oauth/clients`: o admin de plataforma lista e desabilita clientes.
- Fase B: `/settings/identity-provider` (o secret nunca volta; o teste roda a discovery).

## Alternativas descartadas
- **Authorization Server externo obrigatório (Keycloak, Auth0).** Traria de volta o container e a configuração que o ADR-011 removeu, e o token deixaria de ser o do gateway. O login federado da fase B entrega SSO sem delegar a emissão.
- **Access token JWT.** Exigiria gestão e rotação de chaves de assinatura e perderia a revogação em até 15 s. O resource server e o AS são o mesmo processo, então a introspecção local do token opaco não custa nada a mais.
- **Telas na Admin UI.** Dependeria do nginx da Admin UI na frente do gateway e de uma rota fora do gate do `AuthProvider`. O gateway também é publicado sem a UI.
- **Só CIMD.** Seguiria a spec à risca, mas deixaria de fora clientes que ainda só falam DCR durante a janela de depreciação.

## Consequências
- Clientes que só falam OAuth conectam colando a URL da superfície. O usuário entra com a própria identidade, aprova o acesso e revoga quando quiser.
- O token estático continua sendo o caminho para agentes de máquina (`kind = service`). O OAuth é sempre de um humano.
- O gateway passa a servir telas HTML públicas e endpoints de token sem autenticação prévia. Isso amplia a superfície de ataque, coberta pelas ameaças T14 a T19 do ADR-003 e pela suíte `security/oauth`.
- O Redis passa a guardar estado de curta duração do fluxo (pedidos pendentes e o handoff do SSO). Se o Redis cair, o fluxo de autorização para; os tokens já emitidos continuam valendo.
- O `PUBLIC_URL` precisa ser o endereço público real: ele é o `issuer` e a base dos `resource`. Erro de configuração quebra a descoberta nos clientes.
- O ADR-011 fica revisado em dois pontos: os clientes MCP voltam a ter PRM e fluxo OAuth, e "não há SSO" deixa de valer depois da fase B.

## Riscos aceitos
- Um redirect em loopback não prova qual processo local vai receber o código. A tela de consentimento avisa, e o PKCE impede que um terceiro troque o código sem o verifier.
- O fetch de CIMD é uma saída de rede para uma URL escolhida por quem inicia o fluxo. Ele passa por `outboundFetch`, com teto de bytes, timeout, sem redirects e com cache, mas ainda gera tráfego para hosts arbitrários.
- Clientes DCR são autodeclarados. O tenant que quiser só clientes verificáveis usa `allowlist` com hosts de CIMD.
- A revogação de tokens OAuth tem a mesma latência de até 15 s entre réplicas dos tokens estáticos (ADR-011).

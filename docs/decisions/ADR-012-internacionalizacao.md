# ADR-012: Internacionalização (en, pt-BR, es)

- Status: aceito
- Data: 2026-10-03

## Contexto
Todo texto voltado a usuário ou agente estava fixo em pt-BR: Admin UI, mensagens de erro da Admin API e do data plane MCP, meta-tools e instructions do Omni, explicações de política, issues de validação de compostas, erros de crawl e sufixos gerados pelo `openapi-toolgen`. O produto passa a atender usuários em inglês, português e espanhol. Nada no código lia locale.

## Decisão
- **Idiomas:** `en` (default), `pt-BR` e `es`.
- **Pacote puro `@mcp-gateway/i18n`, sem dependência externa.** Usado pelo backend e pela Admin UI.
  - Mensagens em catálogos tipados por área (`defineMessages('proxy', { en, 'pt-BR', es })`). `en` é a fonte de verdade. O typecheck falha se faltar ou sobrar chave em `pt-BR`/`es`, e as chaves usadas no código são tipadas.
  - Sintaxe ICU simplificada: `{nome}`, `{n, plural, one {...} other {...}}` (via `Intl.PluralRules`, `#` = número) e `{x, select, a {...} other {...}}`. Parâmetros podem ser outras mensagens (`Message`), traduzidas recursivamente.
  - Chave ausente no idioma cai para `en`. Datas e números via `Intl`.
- **Idioma vem do perfil do usuário no banco:** coluna `users.locale` (default `en`), exposta no `Principal`. Vale para humanos (UI e Admin API) e para usuários `service` (agentes no `/mcp`). O usuário troca o próprio idioma por `PATCH /admin/v1/me`; o admin também pode definir pela gestão de usuários.
- **Resolução por request:** `principal.locale` → `Accept-Language` negociado (requests sem autenticação, como login e 401) → `en`.
- **Erros carregam chave, não texto.** `GatewayError` guarda `Message { key, params }` e é renderizado na borda (`toJSON`, `toMcpError`, `toToolResult` recebem o locale). `error.message` fica em inglês, para logs. O `code` estável não muda. Textos de terceiros (resposta do upstream, Zod, `JSON.parse`) são repassados sem tradução.
- **Pacotes puros devolvem `Message`**, não string (`Decision.explanation` da policy, issues de validação de compostas). Quem renderiza é o gateway.
- **Dados persistidos guardam chave:** `crawl_runs.error_key/error_params` (o `error` antigo vira texto em inglês) e `composite_definitions.validation_errors` com `{ path, key, params }`.
- **MCP:** meta-tools, artifact-tools e instructions padrão são montados no idioma do principal na criação do servidor. Uma sessão Omni fixa o idioma na criação. O sufixo "somente leitura / destrutiva" deixa de ser persistido pelo toolgen e é anexado no `tools/list` a partir das `annotations`. Textos dentro de JSON Schema gerado ficam em inglês fixo: são dados persistidos lidos por LLMs, e localizá-los exigiria regerar por idioma.
- **Não traduzido:** texto digitado por tenants (descrições, instructions, overrides) e conteúdo vindo das APIs upstream. A busca FTS continua com `portuguese` (ADR-009): indexa o conteúdo das tools, não o idioma do usuário.
- **Código em inglês:** mensagens-fonte, logs, comentários e nomes de testes. A documentação (PLAN, ADRs, docs/) continua em pt-BR.

## Consequências
- Mudança incompatível de API: textos de erro mudam de idioma (o default passa a ser inglês) e chaves de `details` em pt viram inglês (`campo` → `field`, `conhecidos` → `known`, `seletores` → `selectors`). Clientes devem decidir pelo `error`/`code`, nunca pelo texto.
- Toda mensagem nova exige entrada nos três idiomas; o typecheck garante isso.
- Mudar o idioma de um usuário afeta suas próximas requests em até 15 s nas outras réplicas (cache do `TokenVerifier`, ADR-011).

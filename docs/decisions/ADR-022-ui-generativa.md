# ADR-022: UI generativa nas respostas das tools (MCP Apps + mcp-ui-kit)

- Status: aceito
- Data: 2026-10-09
- Depende de: ADR-021

## Contexto
Agentes de chat que consomem o gateway mostram o resultado das tools como texto. O protótipo "Trama Console" mostrou o valor de exibir, dentro da conversa:
- tabela, gráfico e card com o resultado;
- formulário pré-preenchido para tools de escrita;
- plano com confirmação para ações destrutivas.

O mercado convergiu para o **MCP Apps** (SEP-1865, extensão oficial `io.modelcontextprotocol/ui`): o servidor publica HTML em `ui://`, o host o roda em um iframe sandbox, e a view conversa com o host por JSON-RPC. Claude, ChatGPT, VS Code e outros já suportam.

A avaliação de mercado (out/2026) levou a um critério "híbrido enxuto":
- **Padrão na borda:** MCP Apps com o SDK oficial.
- **Código próprio no que diferencia:** o formato da view, a inferência a partir do schema, o tema por tenant e a policy das chamadas vindas da UI.
- **Bibliotecas maduras em problemas comuns:** Leaflet, Mermaid e um validador sem `eval`.
- **Camadas imaturas adiadas:** A2UI, que está em 1.0 RC, e AG-UI.

O código genérico vive no repositório separado **mcp-ui-kit**, com semver próprio:
- `@mcp-ui-kit/view-spec`: contrato, inferência e tema; puro;
- `@mcp-ui-kit/views`: os MCP Apps genéricos, em HTML single-file;
- `@mcp-ui-kit/components`: renderizadores React;
- `@mcp-ui-kit/host`: host fino para chats próprios.

## Decisão

### Contrato
- A UI de uma tool é um `ToolViews` (`view-spec` v1), com dois lados:
  - **`input`:** `form` (JSON Schema + uiSchema) ou `plan` (passos + confirmação);
  - **`result`:** `table`, `chart` (subconjunto de Vega-Lite), `card`, `map` ou `diagram`.
- O gateway só emite specs que passam por `parseToolViews` e `validateSpec` contra o contrato atual da tool.

### Persistência
Migration 0023:
- **`tool_views`:** 1:1 com a tool, com `views`, `spec_version` e `status` (`suggested | active | disabled`), no padrão de `projections`.
  - O crawler grava `suggested` via `infer()` e nunca ativa sozinho.
  - Só `active` chega ao snapshot.
- **`tenant_themes`:** guarda `tokens` (`ThemeTokens`, validados com `validateTheme` na escrita) e o basemap opcional do mapa (`tile_url`, `tile_attribution`).

### Quando a UI aparece
"Cliente com UI" é:
- cliente 2026-07-28 que declarou `io.modelcontextprotocol/ui` no envelope (ADR-021);
- **ou** cliente 2025: no modo stateless o gateway não vê o `initialize`, e clientes sem suporte ignoram `_meta` desconhecido.

Clientes sem UI e o Playground continuam recebendo exatamente o resultado de hoje.

### Emissão
- **Descriptor:** quando a tool tem view ativa, recebe `_meta.ui.resourceUri = ui://mcp-gateway/{view|map|diagram}`, escolhido por `resourceFor`, e `_meta["openai/outputTemplate"]` com o mesmo URI.
- **Resultado:**
  - `_meta["io.github.leandro-jm.mcp-ui-kit/views"] = ViewPayload` (fase `result`, `truncated` quando houve artifact offload);
  - `_meta["io.github.leandro-jm.mcp-ui-kit/theme"]` com os tokens do tenant.
  - O `content` em texto e o `structuredContent` não mudam. O `_meta` não entra no contexto do modelo.
- **Formulário:** se a validação dos argumentos falha e a tool tem `input.kind = form`, o resultado de erro carrega a fase `input`, com os erros por campo (localizados) e os argumentos recebidos. A view mostra o formulário pré-preenchido, e o envio chama a tool de novo, passando por toda a policy.
- **Confirmação humana de ações destrutivas:**
  - **Condição:** a tool tem `input.kind = plan` e o cliente é 2026-07-28 com UI.
  - **Primeira chamada, sem token:** o gateway **não executa**. Devolve a fase `input` com um `confirmToken`, que é HMAC da chave de analytics do tenant com separação de domínio e amarra tenant, sujeito, tool e expiração de 10 minutos. Devolve também um texto ao modelo dizendo que a confirmação é do usuário.
  - **Envio do token:** só a view o envia, no `params._meta["io.github.leandro-jm.mcp-ui-kit/confirm"]`. O modelo nunca o vê.
  - **Validade:** o token é de uso único (nonce em memória por réplica, com expiração curta).
  - **Clientes 2025:** não passam por essa porta, porque o gateway não sabe se renderizam UI. Para eles, vale a policy de sempre.
- **Origem da chamada:** a view envia `_meta[".../origin"] = "app"`, que é informativo. O `CallEvent` registra `meta.ui = { origin, phase }`, sem payload, e nunca usa isso para autorização.

### Resources
- `resources/list` e `resources/read` são compostos por provedores: `artifact://` (F8) e `ui://mcp-gateway/*`.
- O HTML vem de `@mcp-ui-kit/views` (`mimeType text/html;profile=mcp-app`).
- O CSP do recurso só declara o host do basemap do tenant (no `map`). O resto fica no padrão restritivo do host.

### Dependência do kit
- `view-spec` (puro) e `views` (estático) entram no runtime; `components` entra só na Admin UI.
- Enquanto o kit não é publicado no npm, o gateway os consome por `link:` para o repositório irmão. Essa ligação é temporária e precisa sair antes de um release.

### Admin
- `GET|PUT|DELETE /admin/v1/tools/:id/view` e `POST /admin/v1/tools/:id/view/suggest`.
- `GET|PUT|DELETE /admin/v1/settings/theme`.
- A Admin UI renderiza o preview com `@mcp-ui-kit/components`, sem iframe: o conteúdo é do próprio tenant.

## Consequências
- Tools sem view, clientes sem UI e o Playground não mudam de comportamento.
- O gate de confirmação muda o fluxo de tools destrutivas com view ativa para clientes 2026-07-28 com UI: a execução passa a exigir um clique humano.
- Templates HTML enviados por tenant, A2UI e AG-UI ficam fora do escopo. Reavaliar o A2UI quando sair a 1.0 e houver um host consumidor concreto.

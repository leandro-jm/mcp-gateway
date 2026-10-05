# ADR-001: Versão da spec MCP e uso do SDK

- Status: aceito
- Data: 2026-10-03

## Contexto
O PLAN §6 pede compatibilidade com a versão estável vigente da spec MCP suportada pelo SDK oficial, registrada em ADR.

## Decisão
- SDK: `@modelcontextprotocol/sdk` **1.32.x**.
- Protocolo: **2025-11-25** (`LATEST_PROTOCOL_VERSION` do SDK). A negociação aceita também as versões 2025-06-18, 2025-03-26 e 2024-11-05, que o SDK ainda suporta.
- Transporte: **Streamable HTTP** (`POST /mcp`, `/mcp/s/:slug`, `/mcp/omni`).
- **Stateless por padrão**: um `Server` de baixo nível e um transport por requisição, com `sessionIdGenerator: undefined` e `enableJsonResponse: true`. Respostas são JSON, sem SSE, o que facilita o escalonamento horizontal.
- `GET /mcp` (stream SSE de notificações) só existe no modo com sessão. Esse modo entra na F7.2 para `notifications/tools/list_changed`. Em modo stateless, `GET`/`DELETE` respondem `405`.
- Uso o `Server` de baixo nível (não o `McpServer`) porque o catálogo de tools é dinâmico por tenant, sujeito e virtual server.
- Erros:
  - Tool desconhecida ou desabilitada → erro JSON-RPC `-32602`.
  - Validação, autorização e erros de upstream → resultado de tool com `isError: true`, para que o modelo possa se corrigir.

## Consequências
Clientes MCP precisam enviar `Accept: application/json, text/event-stream`, como exige a spec. Atualizar o SDK exige rever este ADR.

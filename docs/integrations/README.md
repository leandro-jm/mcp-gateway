# Integração com consumidores (F11.4)

O gateway fala **MCP sobre Streamable HTTP** (protocolo 2025-11-25, ADR-001). Todo cliente precisa de duas coisas:

1. **Um token de API do gateway** (ADR-011), enviado em `Authorization: Bearer <token>`:
   - crie um usuário `service` para o agente em **Admin UI → Usuários** (tenant, roles e grupos usados nas políticas);
   - gere o token na aba **Tokens** do usuário (o valor aparece uma única vez);
   - o nome do token vira o `clientId`, usado em policies `client:<nome>` e no rate limit.
2. **Um endpoint**:

| Endpoint | Quando usar |
|---|---|
| `POST /mcp` | Todas as tools que o sujeito pode usar, como tools nativas. |
| `POST /mcp/omni` | Muitas tools: 3 meta-tools (`search_tools`, `get_tool_schema`, `call_tool`) com descoberta incremental, mais a `report_outcome` (F15, configurável). |
| `POST /mcp/s/:slug` e `/mcp/s/:slug/omni` | Um MCP montado na Admin UI (catálogo curado + instruções). |
| `GET /sdk/:tenant.ts` | SDK TypeScript tipado, para agentes que executam código (Code Mode). |
| `POST /mcp/observability` | Analytics do próprio gateway como tools (`analytics_query`, `explain_call`, `top_failing_tools`). Exige o papel `gateway-admin` ou `analytics-reader` (F15.14). |

Requisitos de cliente:
- Enviar `Accept: application/json, text/event-stream`.
- Em respostas grandes, o gateway devolve um `resource_link` `artifact://…`. Leia com as tools `artifact_read`/`artifact_query` ou com `resources/read`.
- Devolver o header `mcp-session-id` recebido no `initialize`. Com ele, o gateway agrupa as chamadas da sessão e registra o agente (ADR-016).
- Para ligar o trace do agente ao do gateway e ao do upstream, envie o contexto W3C em `params._meta.traceparent` (ou no header HTTP `traceparent`).
- O id de cada chamada volta em `_meta["io.github.leandro-jm.mcp-gateway/call-id"]`. Use-o no `explain_call` e no `report_outcome`.

Guias:
- [Claude Code e Claude Desktop](./claude-code.md)
- [Cliente genérico (SDK oficial, curl)](./generico.md)

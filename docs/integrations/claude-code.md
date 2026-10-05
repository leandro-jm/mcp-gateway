# Claude Code e Claude Desktop

Todo acesso usa um **token de API do gateway** (ADR-011): crie um usuário `service` em **Admin UI → Usuários**, gere o token na aba **Tokens** e guarde o valor (ele aparece uma única vez). Para uso pessoal, gere o token em **Admin UI → Tokens** com o seu próprio usuário.

## Claude Code (CLI)
```bash
export MCP_GATEWAY_TOKEN=mgw_...
claude mcp add --transport http mcp-gateway https://mcp.empresa.com/mcp/omni \
  --header "Authorization: Bearer $MCP_GATEWAY_TOKEN"
```
Ou em `.mcp.json` no repositório (a Admin UI gera este snippet em **MCP Servers → Conexão**):
```json
{
  "mcpServers": {
    "rh-gestor": {
      "type": "http",
      "url": "https://mcp.empresa.com/mcp/s/rh-gestor",
      "headers": { "Authorization": "Bearer ${MCP_GATEWAY_TOKEN}" }
    }
  }
}
```
O token não expira, a menos que tenha sido criado com validade. Para trocar, gere um novo e revogue o antigo na Admin UI. A revogação vale em até 15 s em todas as réplicas.

## Claude Desktop / claude.ai
Use um conector que aceite header customizado e informe a URL (`https://mcp.empresa.com/mcp/s/<slug>`, ou `/omni`) com `Authorization: Bearer <token>`. O gateway não implementa o fluxo OAuth de clientes MCP: conectores que só aceitam OAuth não conseguem se conectar. Para usar pela internet, o gateway precisa de TLS.

## MCP de observabilidade
O próprio gateway expõe o seu analytics como MCP (F15.14). Isso permite perguntar ao Claude, por exemplo, "por que a tool X falhou mais esta semana?", e ele investiga sozinho com `top_failing_tools`, `explain_call` e `analytics_query`.

Use um token de um usuário com o papel `analytics-reader` (só leitura de analytics) ou `gateway-admin`:
```bash
claude mcp add --transport http mcp-gateway-observability https://mcp.empresa.com/mcp/observability \
  --header "Authorization: Bearer $MCP_GATEWAY_ANALYTICS_TOKEN"
```
As tools nunca devolvem payload: só contagens, latências, regras de política, redactions por tipo de dado e tokens. A consulta é tipada (métrica, dimensões e filtros de uma lista fixa), sem SQL.

## Dicas
- Com centenas de tools, use `/mcp/omni` (cerca de 4% dos tokens de definição, medido na F7.2).
- Para um time específico, crie um MCP na Admin UI (catálogo + instruções) e conecte em `/mcp/s/<slug>`.
- Tools destrutivas exigem allow explícito na política. O Claude só as vê se o usuário dono do token tiver permissão.

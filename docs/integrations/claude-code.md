# Claude Code e Claude Desktop

Há duas formas de autenticar:
- **OAuth, com a conta da pessoa** (ADR-030). A pessoa entra na tela do gateway com o próprio usuário, aprova o acesso e pode desconectar o app depois em **Admin UI → Tokens → Aplicativos conectados**. Precisa de `OAUTH_ENABLED=true` no gateway e da conexão de apps ligada no tenant (**Configurações → Conexão de apps**). É o caminho para conectores que só aceitam OAuth.
- **Token de API do gateway** (ADR-011), para agentes de máquina e clientes que aceitam header fixo: crie um usuário `service` em **Admin UI → Usuários**, gere o token na aba **Tokens** e guarde o valor (ele aparece uma única vez). Para uso pessoal sem OAuth, gere o token em **Admin UI → Tokens** com o seu próprio usuário.

## Claude Code com OAuth
```bash
claude mcp add --transport http mcp-gateway https://mcp.empresa.com/mcp/omni
```
Na sessão do Claude Code, rode `/mcp`, escolha `mcp-gateway` e autentique. O navegador abre a tela de login do gateway; depois de aprovar, o Claude Code guarda os tokens e os renova sozinho. O app aparece em **Aplicativos conectados**, e desconectar ali revoga o acesso na hora.

Se o tenant aceita só os apps da allowlist, o Claude Code precisa estar nela. Clientes que se registram sozinhos (DCR) ganham um id `dcr_…` na primeira tentativa; o admin de plataforma o vê em **Configurações → Conexão de apps → Apps conhecidos pelo gateway** e pode copiá-lo para a allowlist. Outra opção é o tenant aceitar qualquer app: a pessoa sempre passa pela tela de consentimento.

## Claude Code com token de API
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
Com o OAuth ligado, adicione um conector personalizado com a URL do gateway (`https://mcp.empresa.com/mcp/omni`, `/mcp` ou `/mcp/s/<slug>`). O conector descobre o servidor de autorização pela resposta 401 do gateway (`WWW-Authenticate` com `resource_metadata`), abre a tela de login e pede a aprovação da pessoa.

Requisitos:
- O `PUBLIC_URL` precisa ser HTTPS e alcançável pelo app. Conectores do claude.ai partem da nuvem da Anthropic, então o gateway precisa estar na internet.
- Se o tenant usa allowlist, inclua o host do app. Apps que publicam um documento de metadados (CIMD) aparecem em **Apps conhecidos pelo gateway** com o host verificado depois da primeira tentativa.

Sem OAuth, use um conector que aceite header customizado e informe `Authorization: Bearer <token>`.

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
- Com o roteador de tools ligado no tenant (ADR-025), o header `mcp-gateway-intent` no `.mcp.json` faz o `tools/list` devolver só as tools relevantes para a tarefa (texto com acento vai percent-encoded, por exemplo `"mcp-gateway-intent": "f%C3%A9rias%20e%20ponto"`). Veja [docs/tool-router/guia.md](../tool-router/guia.md).
- Tools destrutivas exigem allow explícito na política. O Claude só as vê se o usuário dono do token tiver permissão.

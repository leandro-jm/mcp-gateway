# Cliente MCP genérico

## SDK oficial (TypeScript)
Exemplo completo e executável: [`examples/mcp-client.ts`](../../examples/mcp-client.ts). Ele usa um token de API estático → conexão → `search_tools` → `get_tool_schema` → `call_tool`.
```bash
# token do usuário service agent-dev, criado por `pnpm db:seed`
MCP_GATEWAY_TOKEN=mgw_dev-agent-token-somente-para-desenvolvimento GATEWAY_URL=http://localhost:4000 \
pnpm tsx examples/mcp-client.ts "dados do colaborador pelo id"
```
Trecho essencial:
```ts
const client = new Client({ name: 'meu-agente', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('https://mcp.empresa.com/mcp'), {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
}));
const { tools } = await client.listTools();
const r = await client.callTool({ name: 'rh_colaborador_get', arguments: { id: 'col-00001' } });
```

## OAuth 2.1
Com `OAUTH_ENABLED=true` (ADR-030), o gateway também é o servidor de autorização dos clientes MCP, seguindo a autorização da spec MCP 2026-07-28. Um cliente com suporte a OAuth só precisa da URL; o SDK oficial faz o fluxo com um `OAuthClientProvider` passado em `authProvider` no transport.

Descoberta:
```bash
# o 401 aponta para o Protected Resource Metadata (RFC 9728) da superfície chamada
curl -si -X POST https://mcp.empresa.com/mcp/omni | grep -i www-authenticate
# Bearer realm="mcp-gateway", resource_metadata="https://mcp.empresa.com/.well-known/oauth-protected-resource/mcp/omni", scope="mcp"
curl -s https://mcp.empresa.com/.well-known/oauth-protected-resource/mcp/omni
curl -s https://mcp.empresa.com/.well-known/oauth-authorization-server
```

Regras do servidor de autorização:
- **Só clientes públicos.** `token_endpoint_auth_method` é sempre `none` e a prova de posse é o PKCE `S256` (obrigatório; `plain` é recusado).
- **Registro do cliente:**
  - **Client ID Metadata Document (CIMD)**, o caminho principal: o `client_id` é uma URL HTTPS que serve os metadados do app (`client_id`, `client_name`, `redirect_uris`). O host dessa URL vira o `clientId` das policies (`oauth:<host>`).
  - **Registro dinâmico (RFC 7591)** em `POST /oauth/register`, por compatibilidade, se `OAUTH_DCR_ENABLED=true`. O nome declarado não é verificado e o `clientId` das policies é `oauth:dcr:<client_id>`.
- **Redirect URI:** casamento exato. Só em loopback (`127.0.0.1`, `[::1]`, `localhost`) a porta pode variar. HTTP só é aceito em loopback, e esquemas próprios (`cursor://…`) só para apps nativos.
- **`resource` (RFC 8707):** o próprio gateway ou uma das superfícies MCP. O token vale em todas as superfícies; quem decide as tools continua sendo a política.
- **Escopos:** `mcp` (sempre concedido) e `offline_access` (emite refresh token).
- **Resposta de autorização:** traz `code`, `state` e `iss` (RFC 9207). O código vale 60 s e só pode ser usado uma vez; usar de novo revoga tudo o que ele gerou.
- **Refresh token:** rotaciona a cada uso; apresentar um já usado revoga o acesso inteiro. Revogação em `POST /oauth/revoke` (RFC 7009).
- **Erros** de `/oauth/token`, `/oauth/revoke` e `/oauth/register` seguem o RFC 6749 (`error`, `error_description`).

## HTTP puro (curl)
O modo padrão é stateless: cada POST é independente e pode ir direto para `tools/list`/`tools/call`.
```bash
curl -s https://mcp.empresa.com/mcp -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"rh_colaborador_get","arguments":{"id":"col-00001"}}}'
```

## Code Mode (SDK gerado)
```bash
curl -s https://mcp.empresa.com/sdk/<tenant>.ts -H "Authorization: Bearer $TOKEN" > gateway.ts
```
```ts
import { GatewayClient } from './gateway';
const gw = new GatewayClient({ token: process.env.TOKEN! });
const colab = await gw.rhColaboradorGet({ id: 'col-00001' });   // tipado
```

## Erros
- `-32602` (JSON-RPC): tool desconhecida, desabilitada ou sem permissão.
- `isError: true` com JSON no texto: `VALIDATION_ERROR`, `FORBIDDEN`, `RATE_LIMITED`, `UPSTREAM_CLIENT_ERROR` ou `UPSTREAM_ERROR`, com `message`/`details` úteis para o modelo se corrigir.
- HTTP 401 com `WWW-Authenticate`: token ausente, desconhecido, expirado, revogado ou de outro tenant, ou usuário desativado. Com OAuth ligado, o header traz `resource_metadata` para o cliente iniciar o login.

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
- HTTP 401 com `WWW-Authenticate`: token ausente, desconhecido, expirado, revogado ou de outro tenant, ou usuário desativado.

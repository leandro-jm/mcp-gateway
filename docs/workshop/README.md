# Workshop: MCP Gateway com Claude e ESP32-S3

Apresentação de ~30 min (público misto) em um único HTML, sem build: `index.html`.

## Como abrir

```bash
open docs/workshop/index.html
```

As imagens vêm de `apps/site/public/screens/` por caminho relativo, então abra o arquivo de dentro do repositório. As fontes IBM Plex vêm do Google Fonts; offline, o deck usa as fontes do sistema.

| Tecla | Ação |
|---|---|
| ← → · espaço · PageUp/PageDown | navegar (clique nas metades da tela e swipe também funcionam) |
| `N` | notas do apresentador (roteiro das demos e plano B) |
| `O` / `Esc` | visão geral em grade / sair dela |
| `F` | tela cheia |
| `#n` na URL | abrir direto no slide `n` |

Para gerar um PDF de backup, imprima para PDF no Chrome com gráficos de fundo ligados. Sai um slide por página.

## Checklist da demo

**Case 1 · Claude**
- `pnpm dev:infra`, `pnpm db:migrate && pnpm db:seed`, `pnpm dev`, `pnpm dev:upstream`, crawler e Admin UI rodando.
- A fonte `rh` crawleada, com as tools habilitadas e com policy (login `owner`).
- `claude mcp add --transport http mcp-gateway http://localhost:4000/mcp/omni --header "Authorization: Bearer mgw_dev-agent-token-somente-para-desenvolvimento"`.

**Case 2 · ESP32-S3 (Waveshare ESP32-S3-Touch-AMOLED-1.75C, firmware xiaozhi)**
- Servidor virtual `assistente-voz` com `rh_colaborador_get` e `rh_escalas_list`.
- Usuário service com o token `esp32-sala` e uma policy `client esp32-sala → allow` nas duas tools.
- `mcp_pipe.py` (repositório `78/mcp-calculator`) com `MCP_ENDPOINT` copiado do console xiaozhi.me e um `mcp_config.json` apontando para `http://localhost:4000/mcp/s/assistente-voz` com o header `Authorization`.
- Gateway e crawler com `NETWORK_ALLOW_PRIVATE=true` (já é o padrão no `.env.example` de dev), porque a API fake roda em localhost.
- Device no Wi-Fi do evento. Teste o pipe na rede do local antes de começar.
- Plano B: um vídeo curto gravado da interação por voz.

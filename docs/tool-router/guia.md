# Guia do roteador de tools (F19, ADR-025)

O roteador de tools é um plugin **opcional** que consulta um modelo de decisão (OpenAI Decisions ou TypeSafe Jev) em três pontos:

| Ponto | Onde | O que faz |
|---|---|---|
| Rerank | `search_tools` do Omni | Escolhe, entre os candidatos da busca, a tool que melhor atende a consulta e a coloca no topo |
| Shortlist | `tools/list` em `/mcp` e `/mcp/s/:slug` | Com uma intenção declarada pelo cliente, devolve só os grupos de tools relevantes |
| Gate | `tools/call` | Pergunta se a chamada é arriscada antes de ela chegar à API: permite, pede confirmação ou nega |

Ele roda **depois** da política e só **restringe**. Desligado, o gateway se comporta exatamente como antes.

O porquê das escolhas está no [estudo](estudo-modelos-de-decisao.md) e no [ADR-025](../decisions/ADR-025-roteador-de-tools-modelos-de-decisao.md).

## Ligar

O roteador tem três chaves, e todas precisam estar ligadas:

1. **Plataforma:** `TOOL_ROUTER_ENABLED=true` no gateway. O padrão é `false`, e com ele o roteador nem é criado.
2. **Tenant:** em **Admin UI → Configurações → Roteador de tools**:
   1. Configure o provedor:
      - escolha OpenAI Decisions ou Jev;
      - informe o modelo (opcional) e a API key;
      - clique em **Testar**.
   2. Marque **Ligar o roteador de tools**. Sem um provedor com chave, o gateway recusa a gravação.
3. **Ponto:** ligue cada ponto separadamente. O padrão é rerank ligado, shortlist e gate desligados.

Desligar, em qualquer nível, mantém a configuração e vale na próxima requisição, sem deploy.

O mesmo pode ser feito pela Admin API (`gateway-admin`):

```bash
# provedor e chave (a chave nunca volta nas respostas)
curl -X PUT $GW/admin/v1/settings/tool-router/provider -H "Authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"provider":"openai_decisions","apiKey":"sk-..."}'
curl -X POST $GW/admin/v1/settings/tool-router/test -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{}'

# comportamento
curl -X PUT $GW/admin/v1/settings/tool-router -H "Authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' \
  -d '{"enabled":true,"rerank":{"enabled":true},"shortlist":{"enabled":true},"gate":{"enabled":true,"scope":"destructive"}}'
```

## Intenção para o shortlist

O `tools/list` do MCP não carrega a consulta do agente, então o cliente informa a intenção de uma de duas formas. Quando as duas vêm, o `_meta` vale:

- **`params._meta["io.github.leandro-jm.mcp-gateway/intent"]`** no próprio `tools/list`, para clientes que controlam o request.
- **Header `mcp-gateway-intent`**, fixo por perfil de cliente. Texto com acento vai percent-encoded (`f%C3%A9rias`).

No Claude Code, o header entra no `.mcp.json`:

```json
{
  "mcpServers": {
    "rh-ferias": {
      "type": "http",
      "url": "https://mcp.empresa.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_GATEWAY_TOKEN}",
        "mcp-gateway-intent": "f%C3%A9rias%20e%20ponto%20dos%20colaboradores"
      }
    }
  }
}
```

Sem intenção, a lista é a completa.

O shortlist **não é fronteira de segurança**: uma tool fora da lista continua chamável se a política permitir. Para restringir de fato, use política ou um MCP com `toolSelector`.

## Ajuste fino

| Configuração | Padrão | Quando mexer |
|---|---|---|
| `rerank.candidates` | 20 | Mais candidatos aumentam o recall e o custo. O teto de qualidade é o recall da busca nesse número |
| `rerank.minConfidence` / `shortlist.minConfidence` | 0,35 | Abaixo disso, o resultado da busca ou a lista completa é mantido |
| `shortlist.granularity` | `namespace` | `tool` escolhe tools individuais entre os candidatos da busca; útil quando as tags não agrupam bem |
| `shortlist.mass` / `maxNamespaces` / `minTools` / `maxTools` | 0,9 / 3 / 5 / 30 | Quantos grupos e tools ficam |
| `gate.scope` | `non-readonly` | `destructive` reduz latência e custo; `all` inclui leituras |
| `gate.argsMode` | `redacted` | `none` envia só os nomes dos argumentos |
| `gate.confirmAt` / `gate.denyAt` | 0,5 / 0,9 | Calibre com a avaliação offline e com as métricas por motivo |
| `gate.onError` | `allow` | `deny` torna o gate obrigatório (o provedor fora do ar bloqueia escritas) |
| `gate.onConfirmWithoutUi` | `deny` | `allow` deixa passar quando não há UI de confirmação (ADR-022) |
| `maxDecisionsPerMinute` | 600 | Teto de custo por tenant; acima dele o roteador volta ao comportamento sem ele |
| `cacheTtlSeconds` | 600 | Cache das decisões de rerank e shortlist (o gate nunca usa cache) |

Os timeouts por ponto vão de 100 a 5000 ms (padrões: rerank 1500, shortlist 2000, gate 1500).

## Avaliação offline

- **Em CI:** `pnpm test:int` roda a avaliação `router-eval.int.test.ts` sobre o conjunto da F7.1 (200 tools, 50 consultas):
  - com um provedor "oráculo", o top-1 tem de alcançar o recall@20 da busca;
  - com um provedor que sempre falha, o resultado tem de ser o da busca.
- **Medição em 2026-10-22:**
  - FTS: top-1 de 66%, top-3 entre 88% e 92%, recall@20 de 100%;
  - um modelo de decisão perfeito levaria o top-1 a 100%;
  - cerca de 885 tokens de entrada por decisão de rerank com 20 candidatos.
- **Contra o provedor real** (stack de dev e chave):

  ```bash
  ROUTER_EVAL_PROVIDER=openai_decisions ROUTER_EVAL_API_KEY=sk-... pnpm --filter @mcp-gateway/gateway router-eval
  ```

  O script imprime recall, top-1 e top-3 com e sem o modelo, latência p50/p95, tokens e os motivos das decisões. Registre os números em `docs/perf/`.

## Observabilidade

- **Evento por chamada:** cada decisão vai para o `CallEvent`. `plugins[]` traz ponto, decisão, motivo, provedor, modelo, faixa de confiança, cache, candidatos e mantidos; `gate` traz o resultado do gate; `plugins_ms` traz o tempo. Nunca entram consulta, intenção ou argumentos.
- **Métricas:**
  - `mcp_router_decisions_total{point,provider,decision,reason}`;
  - `mcp_router_duration_seconds{point,provider}`;
  - `mcp_tokens_saved_total{mechanism="shortlist"}`.
- **Motivos:**

  | Motivo | Significado |
  |---|---|
  | `ok` | Aplicado |
  | `low_confidence`, `none_option` | O modelo não teve certeza |
  | `refusal` | O provedor recusou a pergunta |
  | `invalid` | Resposta fora do formato |
  | `too_many` | Mais grupos do que o provedor aceita |
  | `timeout`, `error` | Falha do provedor |
  | `circuit_open` | O provedor falhou 5 vezes em 30 s |
  | `budget` | Orçamento por minuto esgotado |
  | `no_intent` | O cliente não declarou intenção |
  | `human_confirmed` | Confirmação humana do ADR-022 |
  | `disabled` | Ligado, mas sem provedor configurado |

PromQL útil:

```promql
# taxa de fallback por ponto
sum by (point) (rate(mcp_router_decisions_total{decision="skipped",reason!~"ok|no_intent"}[5m]))
  / sum by (point) (rate(mcp_router_decisions_total[5m]))
# p95 do gate
histogram_quantile(0.95, sum by (le) (rate(mcp_router_duration_seconds_bucket{point="gate"}[5m])))
```

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| Nada muda e não há `mcp_router_*` | `TOOL_ROUTER_ENABLED` desligado, chave do tenant desligada ou ponto desligado |
| Motivo `disabled` | O roteador está ligado, mas falta o provedor ou a API key |
| Muitos `low_confidence` | Descrições de tools pouco distintas; revise títulos e descrições ou baixe `minConfidence` com cuidado |
| `too_many` no shortlist | Mais grupos que o limite do provedor (64 na OpenAI, 255 no Jev); use `granularity: tool` |
| Escritas negadas com "precisa de confirmação" | `onConfirmWithoutUi: deny` e um cliente sem UI de confirmação |

## Dados e LGPD

Ligado, o gateway envia ao provedor:
- as descrições das tools candidatas;
- a consulta ou intenção do agente, com PII redigida;
- no gate, os argumentos com PII redigida, ou só os nomes deles com `argsMode: none`.

O provedor passa a ser um operador de dados do tenant. Confirme o contrato de tratamento (transferência internacional, art. 33 da LGPD) antes de ligar. A OpenAI oferece ZDR e residência na UE; o Jev ainda não tem DPA público.

# Relatório de performance (F11.2)

**Meta:** overhead do gateway com p95 < 30 ms, sem contar o upstream, a 200 rps numa instância.
**Resultado:** p95 do overhead ≈ **4,4 ms** a 200 rps, 0% de erro. ✅

## Ambiente (2026-10-03)
- Máquina: Apple M4, 10 núcleos, 24 GB. Tudo local: gateway, upstream fake, Postgres, Redis e MinIO.
- Gateway: **uma instância** do bundle de produção (`pnpm --filter @mcp-gateway/gateway build` → `node dist/main.js`), com `NODE_ENV=production` e `LOG_LEVEL=warn`.
- Pipeline completa ligada:
  - autenticação (na medição, JWT com as chaves públicas em cache; desde o ADR-011 é token opaco consultado no Postgres com cache de 15 s, e a medição ainda não foi refeita);
  - política (default deny + allow por role);
  - rate limit no Redis (limites altos para não interferir);
  - validação Ajv;
  - credencial OAuth2 (token em cache);
  - redaction de PII: 7 campos por resposta;
  - auditoria no Postgres (1 insert por chamada);
  - métricas e traces (sem exporter).
- Tool: `rh_colaborador_get` (`GET /colaboradores/{id}`), ids variados.
- Carga: k6 2.3 em Docker, `constant-arrival-rate` de **200 req/s por 60 s**. Script em [`perf/k6/gateway.js`](../../perf/k6/gateway.js).

## Método
O mesmo k6 executa dois cenários em sequência, cada um com 200 rps por 60 s:
1. `gateway`: `POST /mcp` com `tools/call`, Streamable HTTP stateless e resposta JSON.
2. `upstream` (linha de base): `GET /colaboradores/{id}` direto no upstream fake.

Overhead ≈ p95(gateway) − p95(upstream). O caminho de rede do k6 (Docker → host) é igual nos dois cenários e se cancela.

## Resultados
| Cenário | Requisições | Erros | med | p90 | p95 | p99 | máx |
|---|---|---|---|---|---|---|---|
| gateway (`tools/call`) | 12 001 | 0% | 2,97 ms | 4,67 ms | **5,41 ms** | 7,73 ms | 33,96 ms |
| upstream direto | 12 001 | 0% | 0,63 ms | 0,90 ms | **1,04 ms** | 1,45 ms | 19,16 ms |
| **overhead estimado** | | | ~2,3 ms | ~3,8 ms | **~4,4 ms** | ~6,3 ms | |

As métricas do próprio gateway (`/metrics`) depois da rodada confirmam o número:
- `mcp_tool_call_duration_seconds`: média de 1,43 ms por chamada (34,30 s / 24 003);
- `mcp_upstream_duration_seconds`: média de 0,33 ms (8,00 s / 24 003);
- ou seja, cerca de **1,1 ms em média** de processamento interno (authz, validação, redaction, auditoria).

O resumo bruto do k6 está em [`k6-2026-10-03.txt`](./k6-2026-10-03.txt).

## Limites deste teste
- O upstream fake é local e rápido. Com upstreams reais, a latência total é dominada pelo upstream; o overhead medido aqui se soma a ela.
- Uma única instância, sem disputa de CPU com outros serviços de produção. Postgres e Redis rodam na mesma máquina, o que tende a favorecer o resultado (sem latência de rede entre serviços).
- A auditoria síncrona (1 insert por chamada) é o maior custo interno. Acima de algumas centenas de rps por instância, considere gravação em lote (fila) — mudança localizada em `ToolExecutor.call`.

## Como reproduzir
```bash
pnpm dev:infra
FAKE_UPSTREAM_HOST=0.0.0.0 pnpm dev:upstream
pnpm --filter @mcp-gateway/gateway build
(cd apps/gateway && NODE_ENV=production LOG_LEVEL=warn PORT=4100 node --env-file=.env dist/main.js)
# limites de rate altos no tenant (settings.rateLimits) e o token do agent-dev criado por `pnpm db:seed`:
TOKEN=mgw_dev-agent-token-somente-para-desenvolvimento
docker run --rm -v $PWD/perf/k6:/k6 -e TOKEN=$TOKEN grafana/k6 run /k6/gateway.js
```

## Re-medição com a F15 (2026-10-04)
**Objetivo:** confirmar que o evento largo por chamada (ADR-016) não piora o overhead em mais de 2 ms no p95.

**Resultado:** p95 do overhead ≈ **4,55 ms**, contra 4,4 ms na F11.2 (cerca de +0,15 ms). Erro de 0%. ✅

**Ambiente:** a mesma máquina, o mesmo script, a mesma carga (200 rps por 60 s em cada cenário) e o bundle de produção (`node dist/main.js`). Mudam três coisas em relação à F11.2:
- `NODE_ENV=development`, porque o banco de dev usa a master key de desenvolvimento, que o modo produção recusa;
- autenticação por token opaco com cache (ADR-011), ainda não medida antes;
- pipeline com tudo o que a F15 acrescentou:
  - evento largo;
  - escrita em lote em `call_events`;
  - fingerprints LGPD nos argumentos e na resposta;
  - hash dos argumentos;
  - métricas por etapa;
  - id de chamada no `_meta`.

| Cenário | Requisições | Erros | med | p90 | p95 | p99 | máx |
|---|---|---|---|---|---|---|---|
| gateway (`tools/call`) | 12 001 | 0% | 2,72 ms | 4,53 ms | **5,62 ms** | 9,44 ms | 80,74 ms |
| upstream direto | 12 001 | 0% | 0,65 ms | 0,95 ms | **1,07 ms** | 1,44 ms | 10,22 ms |
| **overhead estimado** | | | ~2,1 ms | ~3,6 ms | **~4,55 ms** | ~8,0 ms | |

- **Pelas métricas do gateway:** `mcp_gateway_overhead_seconds` dá média de 1,33 ms por chamada (15,92 s / 12 001). Todos os 12 001 eventos foram gravados (`mcp_call_events_written_total`) e nenhum foi descartado.
- **Achado da medição (corrigido na F15.25):** a primeira rodada deu p95 de ~8,8 ms de overhead e p99 de 34 ms. O writer montava um `INSERT` com dezenas de milhares de parâmetros a cada flush e travava o event loop. Ele passou a enviar o lote como um único parâmetro JSON (`json_populate_recordset`).

O resumo bruto do k6 está em [`k6-2026-10-04-f15.txt`](./k6-2026-10-04-f15.txt).

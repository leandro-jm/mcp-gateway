# ADR-027: Benchmark de agentes contra o gateway

- Status: aceito
- Data: 2026-11-03
- Depende de: ADR-009, ADR-016, ADR-025

## Contexto
O gateway oferece quatro formas de um agente consumir um catálogo grande de tools:
- todas as tools nativas (`/mcp/s/:slug` em modo `full`);
- o Omni com busca FTS (ADR-009);
- o Omni com rerank por modelo de decisão (ADR-025);
- o shortlist por intenção (ADR-025).

Não há medição de ponta a ponta com um modelo real que compare essas formas em desempenho, assertividade e custo. As medições existentes são de outro tipo:
- overhead do gateway com k6 (`docs/perf/README.md`);
- avaliação offline do FTS e do rerank sobre 200 tools sintéticas (`docs/tool-router/guia.md`).

O teste `omni.int.test.ts` estima os tokens de definição, mas não executa um agente.

A medição é para um case público, com a API mock de 160 tools cadastrada no gateway de produção. O orçamento é de US$ 10 em chamadas à Anthropic.

## Decisão

### App separado
- O harness fica em `apps/bench` (`@mcp-gateway/bench`), um app de I/O fora dos pacotes puros, rodado com `tsx`.
- Ele fala com o gateway só por HTTP: a Admin API para preparar o ambiente e o MCP para medir. Não importa código do gateway. Assim mede o que um cliente externo vê e roda contra qualquer instalação.
- A pontuação, o custo e as estatísticas são funções puras com testes unitários.

### Cenários
| Cenário | Endpoint | Roteador |
|---|---|---|
| A. Direto | `/mcp/s/bench-full` (`full`) | desligado |
| B. Omni | `/mcp/s/bench-omni` (`omni`) | desligado |
| C. Omni + rerank | `/mcp/s/bench-omni` | `rerank` ligado |
| D. Shortlist | `/mcp/s/bench-full` + `mcp-gateway-intent` | `shortlist` ligado |

- O roteador é configuração do tenant, então a rodada tem duas fases: A e B com o roteador desligado, C e D com ele ligado.
- O toggle acontece uma única vez, seguido de uma requisição de aquecimento descartada, para que a reconstrução do snapshot do registry não entre na latência medida.
- O gate fica sempre desligado.

### Agente e modelos
- O loop de tool use é manual, sobre a Messages API. O `LlmProvider` do gateway faz uma única chamada estruturada.
- Modelos: Claude Haiku 5.5 (80 tarefas × 3 repetições) e Claude Sonnet 5.5 (as primeiras N ≤ 20 tarefas × 1).
- Todos os cenários usam o mesmo system prompt, `effort: medium` e cache de prompt ligado.
- O custo sem cache é recalculado a partir do mesmo `usage`, repreçando os tokens de cache como entrada normal. O comportamento do modelo não depende do cache.
- Um modelo falso, que segue o gabarito, valida o pipeline sem custo.

### Métricas
Medidas pelo harness:
- tokens de definição e totais;
- turnos;
- latência p50 e p95;
- acerto na primeira chamada;
- sequência e argumentos;
- sucesso da tarefa, com intervalo de Wilson de 95%;
- tools inventadas e erros de validação;
- custo por tarefa.

Cruzadas com o gateway: `/admin/v1/calls` e `/admin/v1/analytics/query`, correlacionados por `clientInfo.name` (`bench-<cenário>`).

### Ambiente e isolamento
- A rodada usa o tenant de testes onde a API mock já está cadastrada, reaproveitando a credencial.
- Antes de mudar qualquer coisa, o setup:
  - grava um snapshot das tools ativas, das políticas, do roteador, dos settings e dos virtual servers;
  - simula as políticas existentes para cada usuário do tenant, e para se a ativação expuser tools a outro sujeito.
- O acesso do agente é uma política `allow` de `subjectType: client`, presa ao token `bench-agent`.
- O `restore` volta o roteador e os settings ao snapshot e revoga o token. Desativar as tools é opcional.

### Orçamento
- Há um teto duro por modelo (Haiku US$ 4, Sonnet US$ 6) e um total (US$ 10). O custo é somado após cada execução, e a rodada para ao atingir o teto. A rodada é retomável.
- O piloto (as 5 primeiras tarefas) mede o custo real e define o N do Sonnet antes da rodada completa.

### Dados enviados a terceiros
- À Anthropic vão os prompts das tarefas (escritos para o benchmark), as definições das tools da mock e as respostas da mock.
- Ao Jev vão a consulta de busca e os candidatos, como em qualquer rerank (ADR-025).
- Nenhum dado de tenant real sai do gateway.

## Consequências
- O case tem números reproduzíveis; o `apps/bench` mais o gabarito bastam para repetir a rodada.
- Com 1 repetição, o Sonnet é uma referência exploratória; a base estatística é o Haiku.
- A API mock responde rápido e de forma determinística. A latência do upstream é menor que a de APIs reais, e o artigo declara isso.
- O custo do rerank não sai do `/calls` (que não expõe `plugins[]`): é estimado pelo número de buscas e conferido no painel do Jev.
- As tarefas de escrita alteram os dados da mock; a pontuação olha a chamada, não o estado final.

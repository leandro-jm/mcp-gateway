# Benchmark de agentes: 162 tools via MCP Gateway (ADR-027)

**Pergunta:** o que acontece com acerto, latência e custo quando um agente usa uma API com 162 tools, direto ou através dos modos de descoberta do gateway?

**Resultado:**
- Expor as 164 tools direto ao modelo custa **108 mil tokens de definição por chamada**.
- O Omni reduz isso para 1,5 mil tokens. Com o Claude Haiku 5.5, o custo por tarefa cai **12,9×** (44× sem cache), e o sucesso vai de 99% para 91%.
- O shortlist por intenção é o mais rápido, mas erra tarefas de várias etapas (36% de sucesso).
- O rerank não mudou o acerto de forma mensurável.

## Ambiente (2026-11-04)
- **Gateway de produção:** `mcp-gw.niflow.com.br`, uma instância, `TOOL_ROUTER_ENABLED=true`.
- **API:** tenant `nexti`, source `rh_trabalhista`, uma API mock de RH com 14 recursos.
  - Tem 162 tools: CRUD, views (tabela, card, formulário, mapa, gráfico), cálculos, planos e diagramas.
  - O virtual server direto lista 164: as 162 mais 2 tools de artefato do gateway.
- **Modelos:** `claude-haiku-5-5` e `claude-sonnet-5-5`, com `effort: medium`, sem parâmetros de amostragem e `tool_choice: auto`.
  - O cache de prompt fica ligado, com breakpoints no system prompt, na última tool e no histórico.
- **Roteador (ADR-025):** provedor Jev, com rerank e shortlist ligados só na fase 2. O gate fica desligado.
- **Harness:** [`apps/bench`](../../apps/bench), rodada `20261104-022705`, com 400 execuções em sequência.

## Cenários
| Cenário | Endpoint | O que o modelo recebe |
|---|---|---|
| A. Direto | `/mcp/s/bench-full` | As 164 tools |
| B. Omni (FTS) | `/mcp/s/bench-omni` | 6 meta-tools (`search_tools`, `get_tool_schema`, `call_tool`…), com busca textual |
| C. Omni + rerank | `/mcp/s/bench-omni` | As mesmas 6 meta-tools, com os candidatos da busca reordenados pelo Jev |
| D. Shortlist | `/mcp/s/bench-full` + header `mcp-gateway-intent` | Só os grupos de tools que o Jev escolheu para a intenção (granularidade `namespace`) |

## Método
- **Gabarito:** [`apps/bench/tasks/tasks.jsonl`](../../apps/bench/tasks/tasks.jsonl), com 80 tarefas em pt-BR sobre os dados reais da mock:
  - 22 de uma tool;
  - 22 de várias etapas;
  - 22 ambíguas, com caminhos equivalentes aceitos;
  - 14 fora do escopo, em que o certo é não chamar nenhuma tool.
- **Amostra:**
  - Haiku: as 80 tarefas, uma vez em cada cenário.
  - Sonnet: as 20 primeiras, que cobrem os quatro grupos, uma vez em cada cenário.
  - Por causa do teto de US$ 10, não houve repetições. Todas as taxas têm intervalo de 95% (Wilson).
- **Sucesso estrito:**
  - as tools esperadas foram chamadas na ordem, com os argumentos esperados e sem erro;
  - o agente terminou sozinho;
  - nas tarefas fora do escopo, nenhuma chamada de domínio.
  - Retentativas são permitidas. Escritas contam pela chamada, não pelo estado final da mock.
- **Custo:**
  - Vem do `usage` real de cada turno, com os [preços oficiais](https://platform.claude.com/docs/en/about-claude/pricing) de 2026-11-03.
  - O Haiku 5.5 cobra 5× mais por token quando o prompt passa de 100 mil tokens.
  - "Sem cache" recalcula os mesmos tokens tratando o cache como entrada normal.
  - O custo do Jev fica fora.

## Resultados: Claude Haiku 5.5 (80 tarefas por cenário)
| Cenário | Sucesso | Tokens de definição | Entrada/tarefa | Turnos | Latência p50 / p95 | Custo/tarefa | Sem cache | 1.000 tarefas |
|---|---|---|---|---|---|---|---|---|
| A. Direto | **99%** (93–100) | 108.351 | 270.681 | 2,5 | 6,3 s / 11,9 s | US$ 0,0179 | US$ 0,1370 | US$ 17,93 |
| B. Omni | 91% (83–96) | 1.512 | 25.735 | 5,2 | 9,2 s / 17,5 s | **US$ 0,0014** | US$ 0,0031 | **US$ 1,39** |
| C. Omni + rerank | 90% (81–95) | 1.512 | 24.765 | 5,0 | 9,1 s / 18,4 s | US$ 0,0014 | US$ 0,0030 | US$ 1,38 |
| D. Shortlist | 76% (66–84) | 11.068 (mediana) | 60.508 | 2,5 | **6,0 s** / 17,7 s | US$ 0,0037 | US$ 0,0210 | US$ 3,71 |

Sucesso por grupo:

| Cenário | Uma tool | Várias etapas | Ambígua | Fora do escopo |
|---|---|---|---|---|
| A. Direto | 95% | 100% | 100% | 100% |
| B. Omni | 95% | 82% | 91% | 100% |
| C. Omni + rerank | 91% | 86% | 86% | 100% |
| D. Shortlist | 100% | **36%** | 77% | 100% |

## Resultados: Claude Sonnet 5.5 (20 tarefas por cenário)
| Cenário | Sucesso | Entrada/tarefa | Turnos | Latência p50 / p95 | Custo/tarefa | Sem cache | 1.000 tarefas |
|---|---|---|---|---|---|---|---|
| A. Direto | 100% (84–100) | 245.393 | 2,3 | 9,0 s / 15,8 s | US$ 0,0571 | US$ 0,4948 | US$ 57,14 |
| B. Omni | 95% (76–99) | 18.028 | 4,5 | 9,9 s / 20,0 s | US$ 0,0183 | US$ 0,0423 | US$ 18,28 |
| C. Omni + rerank | 100% (84–100) | 20.165 | 4,7 | 11,6 s / 17,5 s | US$ 0,0184 | US$ 0,0466 | US$ 18,42 |
| D. Shortlist | 75% (53–89) | 44.532 | 2,2 | 6,6 s / 16,1 s | US$ 0,0484 | US$ 0,0932 | US$ 48,41 |

Nas mesmas 20 tarefas, o Haiku com Omni (95%, US$ 1,47 por 1.000 tarefas) custa **39× menos** que o Sonnet direto (100%, US$ 57,14).

## Visão do gateway (eventos de `/admin/v1/calls`)
| Cenário | Tipo | Eventos | Overhead p50 / p95 |
|---|---|---|---|
| A | chamada de tool | 154 | 16 ms / 86 ms |
| B | chamada de tool | 159 | 11 ms / 74 ms |
| B | meta-tool (busca, schema) | 357 | 47 ms / 122 ms |
| C | meta-tool (busca + rerank) | 338 | 77 ms / 356 ms |
| D | chamada de tool | 159 | 13 ms / 97 ms |

- **Overhead:** é o processamento do próprio gateway, sem o upstream. Fica em 11 a 16 ms no p50 por chamada de tool.
- **Rerank:** acrescenta ~30 ms no p50 e ~230 ms no p95 ao `search_tools`. O cache de decisões, com TTL de 10 min, absorve parte das consultas.
- **Shortlist:** o evento do `tools/list` começa depois dele, então o tempo da decisão não aparece nessa tabela.

## Análise
1. **O custo de expor tudo é o tamanho das definições, não a quantidade de chamadas.**
   - As 164 definições somam 108 mil tokens, ~660 por tool.
   - Com isso, todo turno do Haiku no cenário A cai na faixa de preço acima de 100 mil tokens.
   - O cache faz o trabalho pesado: sem ele, o cenário A do Haiku custaria US$ 0,137 por tarefa, 7,6× mais.
   - O Omni resolve na origem: o agente faz o dobro de turnos (5,2 contra 2,5), mas cada turno carrega ~10× menos tokens.
2. **O Omni troca ~8 pontos de acerto por uma ordem de grandeza de custo**, com o Haiku: 99% contra 91%, com pouca sobreposição entre os intervalos (93–100 e 83–96).
   - **Quase todas as falhas são de descoberta.** A busca não traz a tool que faz a etapa final:
     - `plan_create` para "excluir com plano";
     - `view_form_colaboradores` para "formulário";
     - `chart` para "quantos por tipo de contrato".
   - **Às vezes o agente para antes da escrita final.** Exemplos: `create_ferias` e `patch_colaboradores`.
   - **Com o Sonnet, a diferença é menor:** 95% contra 100% (n = 20).
3. **O rerank não mostrou ganho de acerto nesta API.**
   - No Haiku: 90% contra 91%. No Sonnet: 100% contra 95%, diferença dentro do intervalo.
   - A busca textual já acerta o topo na maioria das tarefas. As falhas que sobram acontecem quando a tool certa nem está entre os candidatos, e reordenar não resolve.
4. **O shortlist é bom para tarefas de uma tool e ruim para várias etapas.**
   - Com granularidade `namespace`, o Jev escolhe os grupos do recurso principal da intenção.
   - Exemplo: "simulação de férias de um colaborador" recebe o grupo `ferias`. Fica de fora `list_colaboradores`, a busca por nome que a tarefa precisa antes.
   - **Sem a tool de busca, o agente tenta resolver tudo no recurso errado.** Exemplo: `list_ferias {q: "Larissa"}`.
   - **Quando a intenção não casa com nenhum grupo**, como nas tarefas fora do escopo, o gateway devolve a lista completa. É o fallback previsto, e por isso a mediana de definições do D é 11 mil tokens e a média é maior.
   - **Saídas possíveis:**
     - granularidade `tool`;
     - `maxTools` maior;
     - sempre incluir as tools de busca do recurso raiz;
     - intenções que descrevam todas as etapas.
5. **A latência acompanha o número de turnos.**
   - O Omni é o mais lento: 9,2 s no p50 com o Haiku, contra 6,3 s no direto. Isso vem dos turnos de busca, não do gateway.
   - O shortlist é o mais rápido (6,0 s), porque mantém os 2,5 turnos do direto com um contexto 10× menor.

## Revisão manual das falhas
A métrica é estrita: o agente precisa seguir as tools do gabarito. Pelo menos 4 das 41 falhas resolveram a tarefa por outro caminho:
- **t36, B e C:** contou os colaboradores por tipo de contrato com 5 listagens filtradas, em vez de usar o gráfico pronto.
- **t79, D:** chegou ao IRRF partindo da busca de holerites por nome.
- **t24, D:** encontrou as rondas do posto 13 depois de várias buscas.

Os números acima ficam como medidos. A revisão só mostra que o sucesso estrito é um limite inferior.

## Limites deste teste
- **Amostra pequena e sem repetições:** n = 80 por cenário no Haiku e 20 no Sonnet. Os intervalos são largos, sobretudo no Sonnet e por grupo.
- **Uma única API:** a mock tem nomes regulares (`list_*`, `get_*`, `view_table_*`…), o que favorece a busca textual. APIs com nomes menos previsíveis tendem a ampliar a diferença entre A e B.
- **Gabarito e intenções escritos pelo autor do benchmark:** as intenções do cenário D são uma frase curta por tarefa. Um cliente real pode mandar intenções melhores ou piores.
- **Rodada sequencial com o cache aquecido:** o custo de gravar os 108 mil tokens no cache aparece só na primeira tarefa de cada modelo. Um tráfego esparso, com o cache expirando a cada 5 min, custaria mais no cenário A.
- **Fora do custo:** as decisões do Jev (rerank e shortlist).
- **Sem o gate** do roteador.
- **Preços e modelos de 2026-11-03.**

## Custo da rodada
US$ 4,80 na Anthropic, incluindo o piloto (US$ 0,95), de um teto de US$ 10.

## Como reproduzir
```bash
cp apps/bench/.env.example apps/bench/.env   # URL, token de platform admin, tenant, source, chaves da Anthropic e do Jev
pnpm --filter @mcp-gateway/bench env:setup     # snapshot, ativa as tools, usuário/token/política/servers do benchmark
pnpm --filter @mcp-gateway/bench bench --pilot # 5 tarefas, mede o custo e projeta a rodada
pnpm --filter @mcp-gateway/bench bench --run <id> --reps claude-haiku-5-5:1
pnpm --filter @mcp-gateway/bench report --run <id>
pnpm --filter @mcp-gateway/bench env:restore [--disable-tools] [--remove-bench]
```
Os dados brutos de cada execução (`runs.jsonl`) e o resumo (`summary.json`, `summary.md`) ficam em `apps/bench/results/<id>/`, fora do git.

# ADR-013: Avaliação isolada de JSONata

- Status: aceito
- Data: 2026-10-04

## Contexto
O ADR-003 (T12) prevê que expressões JSONata rodem com timeout: 5 s no `artifact_query` e timeout global e por step nas compostas. O pentest de 2026-10-03 mostrou que esse timeout não funcionava:
- O JSONata 2.x avalia em cadeias de promises já resolvidas (microtasks). Assim, o `setTimeout` usado em `Promise.race` nunca dispara enquanto a expressão roda.
- Uma recursão exponencial enviada por **qualquer agente** em `artifact_query` congela o event loop do gateway para todos os tenants.

O JSONata 2.2 tem guardrails nativos (`timeout`, `stack`, `sequence`), verificados a cada passo da avaliação. Eles param recursões e laços, mas não funções nativas caras numa única chamada. Por exemplo, `$pad("", 5e8)` bloqueou 2,5 s e alocou 1,4 GB.

## Decisão
1. **Toda** avaliação JSONata passa a usar os guardrails nativos: `timeout`, `stack` (profundidade) e `sequence` (tamanho máximo de sequência).
2. O `artifact_query` é controlado pelo agente, que é um cliente semiconfiável. Ele roda num **processo filho descartável**: `node -e`, com `--max-old-space-size`, IPC e env vazio. O processo filho tem:
   - SIGKILL no timeout;
   - limite de bytes do resultado aplicado dentro do filho;
   - um teto de avaliações simultâneas e em fila por processo (acima dele, responde "ocupado").

   O código do filho é embutido, e ele carrega o `jsonata` pelo caminho resolvido no processo principal. Isso evita um entrypoint extra no `tsup`.

   Um `worker_thread` com `resourceLimits` foi testado e descartado. Um OOM numa alocação grande (`$pad("", 5e8)`) aborta o **processo pai inteiro** (`FATAL ERROR: Reached heap limit`), então não isola.
3. As compostas continuam avaliando no processo principal, só com os guardrails nativos. Suas expressões são escritas por owners (atores semiconfiáveis, ADR-003), e cada step avalia várias expressões curtas. Um processo por expressão custaria latência demais.

## Consequências
- O DoS por recursão ou laço deixa de existir nos dois caminhos.
- No `artifact_query`, o DoS por memória ou CPU de funções nativas também deixa de existir, ao custo de criar um processo por consulta (dezenas de ms) e de serializar o artefato para o filho.
- **Risco aceito**: nas compostas, um owner ainda pode escrever uma expressão com uma função nativa cara (`$pad` gigante). Fica mitigado porque a composta só é executada depois de habilitada e é auditada.

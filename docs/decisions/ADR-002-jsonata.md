# ADR-002: JSONata como linguagem de expressões

- Status: aceito
- Data: 2026-10-03

## Contexto
Duas fases precisam de uma linguagem de expressões sobre JSON:
- **F7b.2** (composição de tools): argumentos dos steps, `when`, `foreach` e mapeamento do output.
- **F8.3** (`artifact_query`): filtrar e agregar artefatos sem trazê-los ao contexto.

O PLAN pede uma escolha única entre JSONata e JMESPath, registrada em ADR.

## Decisão
**JSONata** (pacote `jsonata`).

Motivos:
- **Transformação, não só seleção.** A composição precisa montar objetos novos (output mapping), concatenar, converter tipos (`$number`, `$string`) e usar condicionais (`? :`). O JMESPath é essencialmente de seleção e projeção.
- **Agregações nativas** (`$count`, `$sum`, `$average`, agrupamento com `{}`), essenciais para a F8.3. Exemplo: "quantos colaboradores por escala" → `items{escala_id: $count($)}`.
- **Variáveis de contexto** (`$input`, `$steps`, `$item`) por bindings, exatamente a sintaxe do exemplo do PLAN (`$steps.colab.id`).
- Implementação madura em JS, sem dependências nativas.

## Regras de uso
- Na composição, um valor de argumento que é string começando com `$` é uma expressão JSONata. Qualquer outro valor é literal. Para um literal que começa com `$`, usa-se `{ "$literal": "..." }`.
- **Bindings disponíveis**:
  - `$input`: argumentos da composta;
  - `$steps`: resultados por id de step;
  - `$item` e `$index`: dentro de `foreach`.
- **Segurança**:
  - expressões compiladas uma vez e avaliadas com timeout;
  - limite de profundidade de recursão via `timeboxExpression`;
  - sem acesso a I/O (o JSONata não tem funções de I/O).

## Consequências
- Owners escrevem expressões JSONata no Composer (F10), com validação de sintaxe em tempo real.
- `artifact_query` (F8.3) aceita JSONata.

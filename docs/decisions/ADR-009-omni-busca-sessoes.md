# ADR-009: Busca de tools e sessões do Omni MCP

- Status: aceito
- Data: 2026-10-03

## Contexto
A F7 pede busca de tools em linguagem natural (FTS e, opcionalmente, embeddings), um endpoint `/mcp/omni` com meta-tools e um modo em que as tools encontradas viram tools nativas da sessão (`tools/list_changed`).

## Decisão
**Índice**
- A coluna `tools.search_text` é mantida pelo repositório: nome, título e descrição efetivos (com overrides), nomes de parâmetros e tags.
- `search_tsv` é uma coluna gerada que combina:
  - `simple_unaccent` com peso A, para nomes e termos exatos;
  - `pt_unaccent` com peso B, que é o português com stemming, sem acentos.

**Ranking**
- Pontuação estilo BM25 calculada no Postgres. Cada lexema da consulta pesa pelo IDF entre os candidatos e pela posição (A/B).
- Termos vindos do tesauro de sinônimos pesam 0,6.
- Os candidatos são sempre só as tools que o sujeito pode chamar (política aplicada **antes** da busca).
- Um prior de intenção desempata operações do mesmo recurso:
  - verbo de escrita favorece tools de escrita;
  - sem verbo de escrita, favorece leitura: `list`, ou `get` quando a consulta fala em id ou detalhes.

**Embeddings**
- Opcionais, via `EMBEDDINGS_URL`: qualquer API compatível com `POST /embeddings`.
- Vetores em `tools.embedding` (pgvector, dimensão livre). Um indexador periódico recalcula os vetores quando `md5(search_text)` muda.
- O ranking textual e o vetorial são fundidos por Reciprocal Rank Fusion (k = 60). Se o provedor falha, a busca usa só o FTS.

**Omni**
- `POST /mcp/omni` é stateless e expõe 3 meta-tools: `search_tools`, `get_tool_schema` e `call_tool`. `call_tool` usa a mesma pipeline do proxy.
- **Modo dinâmico**: header `mcp-omni-mode: dynamic` (ou `?mode=dynamic`) no `initialize`. O gateway cria uma sessão Streamable HTTP com `mcp-session-id`.
  - As tools devolvidas por `search_tools` entram na lista da sessão e o servidor emite `notifications/tools/list_changed` pelo stream `GET`.
  - Cada requisição da sessão é reautenticada. A sessão só aceita o mesmo tenant, sujeito e caminho.
  - Sessões ficam em memória e expiram após 30 min ociosas.

## Consequências
- Sessões em memória exigem afinidade por `mcp-session-id` no balanceador quando há várias réplicas. O modo stateless padrão não tem essa exigência.
- O tesauro padrão cobre o vocabulário de RH/ops. Torná-lo configurável por tenant é uma evolução natural.

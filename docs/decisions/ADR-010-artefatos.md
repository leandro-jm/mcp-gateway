# ADR-010: Artefatos (Code Mode, F8)

- Status: aceito
- Data: 2026-10-03

## Contexto
A F8 transforma respostas grandes em artefatos (`artifact://`) acessíveis só pelo mesmo tenant e sessão. O transporte padrão do gateway é stateless (ADR-001), então não existe uma sessão MCP na maioria das chamadas.

## Decisão
**Sessão do artefato**
- Com `mcp-session-id` (modo com sessão), a sessão é esse id.
- Sem ele, é a identidade estável do chamador: `sha256(tenant:sub:client_id)`. Isso equivale a "o mesmo agente". Outro sujeito ou outro client do mesmo tenant não acessa o artefato.

**Armazenamento**
- Objetos no S3/MinIO em `{tenant}/{session}/{tool_call_id}.json`. Metadados na tabela `artifacts` (§3).
- O conteúdo gravado já passou por redaction (F5) e projeção (F6): o artefato nunca contém PII em claro.
- URI: `artifact://{artifact_id}`. O id é um UUID aleatório. A posse é validada no banco (tenant + sessão), nunca pela URI.

**Offload**
- Acontece quando a resposta, pós-redaction e pós-projeção, passa de `settings.artifacts.thresholdBytes` (padrão 32 KiB), ou quando o agente envia `_output: "artifact"`.
- O agente recebe um resumo JSON e um `resource_link`:
  - `artifact_uri`, `size_bytes`, `row_count`;
  - `schema_summary` (campos e tipos dos registros);
  - `preview` (primeiros N registros, com corte em bytes).
- Nesse caso não vai `structuredContent`, porque o resumo não segue o output schema da tool.

**Consulta**
- Meta-tools `artifact_read` (paginação por registros ou bytes) e `artifact_query` (JSONata, ADR-002).
- Também `resources/list` e `resources/read` em `artifact://…`.

**Inputs por referência**
- Formato `{ "$artifact": "artifact://…", "path": "$.items[*].id" }`, com JSONPath reduzido (o mesmo da F6).
- Resolvidos antes da validação, respeitando `limits.maxRequestBytes`.

**TTL e limpeza**
- TTL de `settings.artifacts.ttlSeconds` (padrão 24 h). Um job periódico de manutenção apaga objetos e linhas expirados, junto com os tokens de PII expirados.

**S3 opcional**
- Sem `S3_ENDPOINT`/`S3_BUCKET`, o offload fica desligado: respostas grandes seguem só com projeção.
- As meta-tools de artefato não são anunciadas.

## Consequências
A sessão por identidade permite usar artefatos em clientes stateless sem afinidade. Um agente com o mesmo `sub` e `client_id` em duas conversas enxerga os artefatos de ambas; o TTL limita esse efeito.

## Adendo (F15, ADR-016)
O gateway passa a emitir `mcp-session-id` no `initialize` também no transporte stateless (`settings.observability.issueSessionId`, default ligado). Clientes que seguem a spec devolvem o header, e seus artefatos ficam presos a essa sessão em vez da identidade `sub` + `client_id`. Clientes sem o header mantêm o comportamento acima.

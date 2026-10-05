# ADR-017: Índice de titulares (LGPD) e captura de debug

- Status: aceito
- Data: 2026-10-04

## Contexto
Para a LGPD, a pergunta que importa é "quais agentes e usuários acessaram dados do titular X". O gateway vê todas as chamadas, então pode respondê-la. A regra do projeto, porém, é nunca guardar PII em claro (F9.1, ADR-003 T8).

Os mecanismos que já existem não servem para essa busca:
- A estratégia `hash` do redaction faz hash do valor bruto. `123.456.789-09` e `12345678909` dão hashes diferentes, e o hash é exposto ao agente (`pii_h_…`).
- A sanitização da auditoria usa uma chave fixa zerada. Ela serve para mascarar, não para indexar.

O explorador de chamadas também precisa ver o que entrou e o que saiu de uma chamada (diff bruto × final) e reproduzi-la (replay). Isso exige guardar payloads, que contêm PII.

## Decisão

### Índice de titulares
1. **Fingerprint.** `subjectFingerprint(key, detector, valor) = HMAC-SHA256(key, "<detector>:<valor normalizado>")`, truncado em 16 bytes.
   - A normalização é por detector: só dígitos (com padding) em CPF, CNPJ, PIS e telefone; minúsculas e sem espaços nas pontas em e-mail.
   - A chave é `HMAC(dataKey do tenant, "mcp-gateway:subject-index")`. É distinta da chave do hash de PII, então os `pii_h_…` vistos pelo agente não se cruzam com o índice. Outro tenant gera outro fingerprint.
2. **Coleta.**
   - O motor de redaction (`packages/redaction`, puro) recebe `fingerprints: {key, detectors, max}` e devolve `{detector, fp}[]`.
   - Os fingerprints são coletados **antes** da estratégia, então valores mascarados ou descartados também são indexados.
   - Os argumentos da chamada, depois do detokenize, passam por `scanIdentifiers` (por exemplo, um agente que busca por CPF).
   - Detectores padrão: `cpf`, `cnpj`, `pis`, `email`. São configuráveis em `settings.observability.subjectIndex`.
3. **Tabela `call_subject_refs`.**
   - Colunas: `ts`, `tenant_id`, `call_id`, `detector`, `fp bytea`, `direction`, mais as colunas desnormalizadas `subject` (sanitizado), `client_id`, `agent_name`, `tool_name` e `decision`. Assim o relatório sobrevive à retenção de 30 dias do `call_events`.
   - Particionada por mês, com retenção `SUBJECT_INDEX_RETENTION_MONTHS` (default igual a `AUDIT_RETENTION_MONTHS`).
   - Índice em `(tenant_id, fp, ts)`.
   - Máximo de 200 refs por chamada. Uma listagem maior marca `subject_refs_truncated`, e o relatório lista essas chamadas à parte como "podem conter o titular".
4. **Consulta.**
   - `POST /admin/v1/lgpd/subject-access` (`{detector, value, from, to}`), só para `gateway-admin`.
   - É POST para o valor não aparecer em URL nem em access log, e `value` entra nos caminhos redigidos do logger.
   - Cada consulta é auditada como `lgpd.subject_access`, com o fingerprint e nunca o valor.
   - Não há consulta pelo MCP de observabilidade.

### Captura de debug e replay-mock
5. **Captura opt-in.**
   - O `gateway-admin` (o admin de plataforma via `X-Tenant`) abre uma captura com motivo obrigatório, filtro (`tool`, `subject`, `clientId`, `sessionKey`), `max_calls` ≤ 100 e duração ≤ `DEBUG_CAPTURE_MAX_MINUTES` (60).
   - Kill switch de ambiente: `DEBUG_CAPTURE_ENABLED` (desligado no compose de produção). Também exige S3.
6. **Conteúdo.**
   - Para cada chamada capturada: argumentos brutos, principal, resposta do upstream (ou dos steps) e resultado final.
   - Cifrado com `encryptJson` (envelope da F1, data key do tenant, aad `debug:<tenant>:<callId>`) e gravado no `ArtifactStore` em `debug/<tenant>/<capture>/<callId>`.
   - O item expira em `DEBUG_CAPTURE_RETENTION_HOURS` (24) e é apagado pelo job de manutenção.
   - A gravação acontece depois da resposta, sem bloquear o agente.
7. **Leitura.** `GET /admin/v1/calls/:callId/debug`, só para `gateway-admin`, auditada como `debug.view`. Mostra o diff bruto × final.
8. **Replay-mock.**
   - `POST /admin/v1/calls/:callId/replay` re-executa o pipeline sobre a resposta gravada, por meio de um `RecordedUpstreamAdapter`: authz, validação, redaction, projeção e decisão de offload, todos com a configuração **atual**.
   - Não chama o upstream, não aplica rate limit nem circuit breaker, não detokeniza e não persiste artefato.
   - Devolve original × replay com as diferenças de redactions, bytes, tokens e decisão.
   - Grava a auditoria `tools/replay` e nenhum `call_event`.

## Consequências
- O fingerprint é pseudonimização, não anonimização. Para a LGPD ele **continua sendo dado pessoal**: o acesso é restrito, auditado e tem retenção própria.
- Quem tem a data key do tenant e um CPF candidato consegue confirmar a presença do titular no índice. Esse é exatamente o uso pretendido, e por isso só o admin consulta.
- Uma chamada que lista mais de 200 titulares fica marcada como truncada. Um filtro de Bloom por chamada é a evolução prevista para não perder recall.
- A captura de debug guarda PII cifrada por até 24 h. É uma exceção controlada ao princípio 4 do PLAN, limitada a admin, com motivo, prazo e trilha de auditoria (atualização do ADR-003).

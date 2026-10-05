# ADR-007: Extensões ao modelo de dados do PLAN §3

- Status: aceito
- Data: 2026-10-03

## Contexto
O §3 lista os campos principais. Alguns campos auxiliares são necessários para cumprir os CAs sem gambiarras.

## Decisão
Campos adicionais, todos opcionais ou com default:
- `tools.operation_key`: chave estável `METHOD path` dentro da source. Índice único `(source_id, operation_key)`, usado pelo crawler para casar versões mesmo quando o nome da tool tem override.
- `credentials.name`: rótulo legível, único por tenant.
- `upstream_sources.settings` (jsonb): timeout, retries e limites por source.
- `crawl_runs.tenant_id` e `crawl_runs.trigger` (`manual` | `cron`): filtro por tenant sem join.
- `drift_events.tenant_id` e `drift_events.acknowledged_at`.
- `audit_events.action`: tipo do evento (`tools/call`, `tool.enable`…). Também `tool_name` (nome no momento da chamada) e `details` (jsonb, sempre sem PII).
- `policies.description`.
- `created_at` e `updated_at` em todas as tabelas mutáveis.

## Consequências
O schema é superconjunto do §3. Nenhum campo do §3 foi removido ou renomeado.

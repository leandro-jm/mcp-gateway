-- F15.5: eventos largos de chamada (ADR-016), particionados por dia em ts. Escrita à mão (ADR-006).
CREATE TABLE call_events (
  ts timestamptz NOT NULL,
  call_id uuid NOT NULL,
  parent_call_id uuid,
  tenant_id uuid NOT NULL,
  kind text NOT NULL,
  endpoint text NOT NULL,
  subject text NOT NULL,
  client_id text,
  agent_name text,
  agent_version text,
  session_key text,
  session_source text,
  virtual_server_id uuid,
  request_id text,
  jsonrpc_id text,
  protocol_version text,
  trace_id text,
  span_id text,
  inbound_parent_span_id text,
  tool_id uuid,
  tool_name text NOT NULL,
  tool_version integer,
  tool_kind text,
  source_id uuid,
  via_omni boolean NOT NULL DEFAULT false,
  decision text NOT NULL,
  error_code text,
  error_stage text,
  error_key text,
  upstream_status integer,
  attempts integer,
  policy_rule_id text,
  policy_reason text,
  policy_version text,
  policy_trace jsonb,
  redactions_count integer NOT NULL DEFAULT 0,
  redactions_by_detector jsonb,
  detokenized_count integer NOT NULL DEFAULT 0,
  request_bytes integer,
  upstream_bytes integer,
  bytes_before_projection integer,
  bytes_after_projection integer,
  response_bytes integer,
  projection jsonb,
  artifact_id uuid,
  artifact_bytes integer,
  subject_refs_count integer NOT NULL DEFAULT 0,
  subject_refs_truncated boolean NOT NULL DEFAULT false,
  meta jsonb,
  args_hash text,
  latency_ms integer NOT NULL,
  authz_ms integer,
  validation_ms integer,
  pii_ms integer,
  upstream_ms integer,
  projection_ms integer,
  artifact_ms integer,
  plugins_ms integer,
  overhead_ms integer GENERATED ALWAYS AS (greatest(latency_ms - coalesce(upstream_ms, 0), 0)) STORED,
  def_tokens integer,
  response_tokens integer,
  raw_tokens integer,
  tokens_saved_projection integer NOT NULL DEFAULT 0,
  tokens_saved_artifact integer NOT NULL DEFAULT 0,
  catalog_tokens integer,
  plugins jsonb,
  gate jsonb,
  taint jsonb,
  pinned_version text,
  CONSTRAINT call_events_call_id_ts_pk PRIMARY KEY (call_id, ts)
) PARTITION BY RANGE (ts);

CREATE INDEX call_events_tenant_ts_idx ON call_events (tenant_id, ts DESC);
CREATE INDEX call_events_tenant_tool_ts_idx ON call_events (tenant_id, tool_name, ts DESC);
CREATE INDEX call_events_tenant_session_ts_idx ON call_events (tenant_id, session_key, ts) WHERE session_key IS NOT NULL;
CREATE INDEX call_events_parent_idx ON call_events (parent_call_id) WHERE parent_call_id IS NOT NULL;
CREATE INDEX call_events_tenant_trace_idx ON call_events (tenant_id, trace_id) WHERE trace_id IS NOT NULL;

-- Cria (se não existir) a partição do dia de `day`.
CREATE OR REPLACE FUNCTION call_events_ensure_partition(day date) RETURNS text AS $$
DECLARE
  part text := format('call_events_p%s', to_char(day, 'YYYYMMDD'));
BEGIN
  IF to_regclass(part) IS NULL THEN
    EXECUTE format('CREATE TABLE %I PARTITION OF call_events FOR VALUES FROM (%L) TO (%L)', part, day, day + 1);
  END IF;
  RETURN part;
END;
$$ LANGUAGE plpgsql;

-- Partição padrão: nada se perde se o job de manutenção atrasar.
CREATE TABLE call_events_default PARTITION OF call_events DEFAULT;

SELECT call_events_ensure_partition((now() - interval '1 day')::date);
SELECT call_events_ensure_partition(now()::date);
SELECT call_events_ensure_partition((now() + interval '1 day')::date);
SELECT call_events_ensure_partition((now() + interval '2 day')::date);
SELECT call_events_ensure_partition((now() + interval '3 day')::date);

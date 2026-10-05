-- F15.8: agregados de call_events por hora (dashboards) e por dia/sujeito (chargeback). Escrita à mão (ADR-006).
-- Soma de contadores em jsonb ({"cpf": 2} + {"cpf": 1, "email": 1} = {"cpf": 3, "email": 1}).
CREATE OR REPLACE FUNCTION jsonb_counts_add(acc jsonb, x jsonb) RETURNS jsonb AS $$
  SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) FROM (
    SELECT k, sum(v)::bigint AS v FROM (
      SELECT key AS k, value::bigint AS v FROM jsonb_each_text(coalesce(acc, '{}'::jsonb))
      UNION ALL
      SELECT key, value::bigint FROM jsonb_each_text(coalesce(x, '{}'::jsonb))
    ) t GROUP BY k
  ) s
$$ LANGUAGE sql IMMUTABLE;

CREATE AGGREGATE jsonb_counts_sum(jsonb) (SFUNC = jsonb_counts_add, STYPE = jsonb, INITCOND = '{}');

CREATE TABLE call_rollups_hourly (
  tenant_id uuid NOT NULL,
  bucket timestamptz NOT NULL,
  kind text NOT NULL,
  endpoint text NOT NULL,
  tool_name text NOT NULL,
  tool_id uuid,
  tool_kind text,
  source_id uuid,
  client_id text,
  agent_name text,
  virtual_server_id uuid,
  decision text NOT NULL,
  error_stage text,
  error_code text,
  calls integer NOT NULL,
  latency_sum bigint NOT NULL,
  latency_max integer NOT NULL,
  -- histograma (não cumulativo) com as bordas de LATENCY_BUCKETS_MS + overflow
  latency_buckets integer[] NOT NULL,
  overhead_sum bigint NOT NULL,
  overhead_buckets integer[] NOT NULL,
  upstream_sum bigint NOT NULL,
  authz_sum bigint NOT NULL,
  validation_sum bigint NOT NULL,
  pii_sum bigint NOT NULL,
  projection_sum bigint NOT NULL,
  artifact_sum bigint NOT NULL,
  retries_sum bigint NOT NULL,
  redactions_sum bigint NOT NULL,
  redactions_by_detector jsonb,
  bytes_before_sum bigint NOT NULL,
  bytes_after_sum bigint NOT NULL,
  artifact_bytes_sum bigint NOT NULL,
  response_tokens_sum bigint NOT NULL,
  raw_tokens_sum bigint NOT NULL,
  def_tokens_sum bigint NOT NULL,
  tokens_saved_projection_sum bigint NOT NULL,
  tokens_saved_artifact_sum bigint NOT NULL,
  tokens_saved_omni_sum bigint NOT NULL
);
CREATE INDEX call_rollups_hourly_tenant_bucket_idx ON call_rollups_hourly (tenant_id, bucket);
CREATE INDEX call_rollups_hourly_bucket_idx ON call_rollups_hourly (bucket);

CREATE TABLE usage_rollups_daily (
  tenant_id uuid NOT NULL,
  day date NOT NULL,
  subject text NOT NULL,
  client_id text,
  agent_name text,
  calls integer NOT NULL,
  errors integer NOT NULL,
  denies integer NOT NULL,
  latency_sum bigint NOT NULL,
  response_tokens_sum bigint NOT NULL,
  tokens_saved_sum bigint NOT NULL
);
CREATE INDEX usage_rollups_daily_tenant_day_idx ON usage_rollups_daily (tenant_id, day);
CREATE INDEX usage_rollups_daily_day_idx ON usage_rollups_daily (day);

CREATE TABLE analytics_watermarks (
  name text PRIMARY KEY,
  upto timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

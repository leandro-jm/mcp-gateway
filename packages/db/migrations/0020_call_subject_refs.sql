-- F15.11: índice de titulares (LGPD, ADR-017). Só fingerprints HMAC; particionada por mês. Escrita à mão (ADR-006).
CREATE TABLE call_subject_refs (
  ts timestamptz NOT NULL,
  tenant_id uuid NOT NULL,
  call_id uuid NOT NULL,
  -- detector do identificador; '*' marca uma chamada com mais titulares do que o limite (truncada)
  detector text NOT NULL,
  fp bytea NOT NULL,
  direction text NOT NULL,
  subject text NOT NULL,
  client_id text,
  agent_name text,
  tool_name text NOT NULL,
  decision text NOT NULL
) PARTITION BY RANGE (ts);

CREATE INDEX call_subject_refs_tenant_fp_ts_idx ON call_subject_refs (tenant_id, fp, ts);
CREATE INDEX call_subject_refs_truncated_idx ON call_subject_refs (tenant_id, ts) WHERE detector = '*';

CREATE OR REPLACE FUNCTION call_subject_refs_ensure_partition(month date) RETURNS text AS $$
DECLARE
  start_date date := date_trunc('month', month)::date;
  end_date date := (date_trunc('month', month) + interval '1 month')::date;
  part text := format('call_subject_refs_y%sm%s', to_char(start_date, 'YYYY'), to_char(start_date, 'MM'));
BEGIN
  IF to_regclass(part) IS NULL THEN
    EXECUTE format('CREATE TABLE %I PARTITION OF call_subject_refs FOR VALUES FROM (%L) TO (%L)', part, start_date, end_date);
  END IF;
  RETURN part;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE call_subject_refs_default PARTITION OF call_subject_refs DEFAULT;

SELECT call_subject_refs_ensure_partition(now()::date);
SELECT call_subject_refs_ensure_partition((now() + interval '1 month')::date);
SELECT call_subject_refs_ensure_partition((now() + interval '2 month')::date);

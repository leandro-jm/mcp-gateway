-- F9.1: audit_events particionada por mês (range em ts). Escrita à mão (ADR-006).
ALTER TABLE audit_events RENAME TO audit_events_old;
ALTER INDEX audit_events_tenant_ts_idx RENAME TO audit_events_old_tenant_ts_idx;
ALTER TABLE audit_events_old RENAME CONSTRAINT audit_events_pkey TO audit_events_old_pkey;

CREATE TABLE audit_events (LIKE audit_events_old INCLUDING DEFAULTS) PARTITION BY RANGE (ts);
ALTER TABLE audit_events ADD CONSTRAINT audit_events_id_ts_pk PRIMARY KEY (id, ts);
CREATE INDEX audit_events_tenant_ts_idx ON audit_events (tenant_id, ts);
ALTER SEQUENCE audit_events_id_seq OWNED BY audit_events.id;

-- Cria (se não existir) a partição do mês de `month`.
CREATE OR REPLACE FUNCTION audit_ensure_partition(month date) RETURNS text AS $$
DECLARE
  start_date date := date_trunc('month', month)::date;
  end_date date := (date_trunc('month', month) + interval '1 month')::date;
  part text := format('audit_events_y%sm%s', to_char(start_date, 'YYYY'), to_char(start_date, 'MM'));
BEGIN
  IF to_regclass(part) IS NULL THEN
    EXECUTE format('CREATE TABLE %I PARTITION OF audit_events FOR VALUES FROM (%L) TO (%L)', part, start_date, end_date);
  END IF;
  RETURN part;
END;
$$ LANGUAGE plpgsql;

-- Partição padrão: nada se perde se o job de manutenção atrasar.
CREATE TABLE audit_events_default PARTITION OF audit_events DEFAULT;

SELECT audit_ensure_partition((now() - interval '1 month')::date);
SELECT audit_ensure_partition(now()::date);
SELECT audit_ensure_partition((now() + interval '1 month')::date);
SELECT audit_ensure_partition((now() + interval '2 month')::date);

INSERT INTO audit_events SELECT * FROM audit_events_old;
DROP TABLE audit_events_old;

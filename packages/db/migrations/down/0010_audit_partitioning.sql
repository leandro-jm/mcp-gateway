ALTER TABLE audit_events RENAME TO audit_events_part;
ALTER INDEX audit_events_tenant_ts_idx RENAME TO audit_events_part_tenant_ts_idx;
CREATE TABLE audit_events (LIKE audit_events_part INCLUDING DEFAULTS);
ALTER TABLE audit_events ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);
CREATE INDEX audit_events_tenant_ts_idx ON audit_events (tenant_id, ts);
ALTER SEQUENCE audit_events_id_seq OWNED BY audit_events.id;
INSERT INTO audit_events SELECT * FROM audit_events_part;
DROP TABLE audit_events_part CASCADE;
DROP FUNCTION IF EXISTS audit_ensure_partition(date);

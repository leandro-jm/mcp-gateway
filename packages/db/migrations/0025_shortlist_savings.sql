-- Economia de tokens do shortlist do roteador (ADR-025) nos rollups: até aqui só a do Omni entrava,
-- e a coluna "Poupado" do uso diário ignorava as duas. Escrita à mão (ADR-006).
ALTER TABLE call_rollups_hourly ADD COLUMN tokens_saved_shortlist_sum bigint NOT NULL DEFAULT 0;

-- Recalcula os rollups a partir do primeiro dia UTC completo que ainda tem eventos brutos
-- (CALL_EVENTS_RETENTION_DAYS); as horas anteriores ficam como estavam. Sem eventos, nada muda.
UPDATE analytics_watermarks
   SET upto = least(upto, (SELECT (date_trunc('day', min(ts) AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC' FROM call_events))
 WHERE name = 'call_rollups';

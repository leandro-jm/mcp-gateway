DROP TABLE IF EXISTS analytics_watermarks;
DROP TABLE IF EXISTS usage_rollups_daily;
DROP TABLE IF EXISTS call_rollups_hourly;
DROP AGGREGATE IF EXISTS jsonb_counts_sum(jsonb);
DROP FUNCTION IF EXISTS jsonb_counts_add(jsonb, jsonb);

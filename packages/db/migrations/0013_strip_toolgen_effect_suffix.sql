-- ADR-012: openapi-toolgen no longer persists the pt-BR effect suffix in the description; the gateway
-- appends a localized one at tools/list time from the annotations. Hand-written (data migration, not in
-- the drizzle-kit journal, see ADR-006).
--
-- 1. Strip the old suffix from generated descriptions. `search_text` is left as is: `buildSearchText`
--    still indexes the same Portuguese effect sentence (from the annotations) right after the description,
--    so the indexed text and its embeddings stay valid.
-- 2. NULL `spec_hash` on every openapi tool: the hash covers the description and the JSON Schema texts
--    (now English), so no stored hash matches the new generator output. The crawler treats a NULL hash as
--    "legacy row": when the diff finds no contract change it refreshes the row without a new version or
--    drift event. `tool_versions` snapshots are history and are left untouched.
UPDATE tools
SET
  description = regexp_replace(description, ' (Somente leitura\.|Altera dados \(operação destrutiva\)\.|Altera dados\.)$', '')
WHERE kind = 'openapi'
  AND description ~ ' (Somente leitura\.|Altera dados \(operação destrutiva\)\.|Altera dados\.)$';

UPDATE tools SET spec_hash = NULL WHERE kind = 'openapi';

ALTER TABLE "upstream_sources" DROP COLUMN IF EXISTS "import_meta";
ALTER TABLE "upstream_sources" DROP COLUMN IF EXISTS "spec_format";
DROP TYPE IF EXISTS "source_spec_format";

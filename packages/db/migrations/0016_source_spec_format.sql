CREATE TYPE "public"."source_spec_format" AS ENUM('openapi', 'postman');--> statement-breakpoint
ALTER TABLE "upstream_sources" ADD COLUMN "spec_format" "source_spec_format" DEFAULT 'openapi' NOT NULL;--> statement-breakpoint
ALTER TABLE "upstream_sources" ADD COLUMN "import_meta" jsonb;
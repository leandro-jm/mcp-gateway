ALTER TABLE "audit_events" DROP COLUMN IF EXISTS "parent_call_id";
ALTER TABLE "audit_events" DROP COLUMN IF EXISTS "call_id";
ALTER TABLE "composite_definitions" DROP COLUMN IF EXISTS "source";

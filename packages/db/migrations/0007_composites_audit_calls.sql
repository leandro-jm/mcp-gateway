ALTER TABLE "audit_events" ADD COLUMN "call_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "parent_call_id" uuid;--> statement-breakpoint
ALTER TABLE "composite_definitions" ADD COLUMN "source" text;
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"tool_call_id" uuid,
	"tool_name" text,
	"uri" text NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text DEFAULT 'application/json' NOT NULL,
	"size_bytes" integer NOT NULL,
	"row_count" integer,
	"schema_summary" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_tenant_session_idx" ON "artifacts" USING btree ("tenant_id","session_id","created_at");--> statement-breakpoint
CREATE INDEX "artifacts_expires_idx" ON "artifacts" USING btree ("expires_at");
CREATE TABLE "pii_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"detector" text NOT NULL,
	"value_encrypted" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pii_tokens" ADD CONSTRAINT "pii_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pii_tokens_tenant_expires_idx" ON "pii_tokens" USING btree ("tenant_id","expires_at");
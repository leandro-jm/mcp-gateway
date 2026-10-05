CREATE TYPE "public"."llm_json_mode" AS ENUM('schema', 'object');--> statement-breakpoint
CREATE TYPE "public"."llm_provider" AS ENUM('anthropic', 'openai', 'openai_compatible');--> statement-breakpoint
CREATE TABLE "tenant_llm_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"provider" "llm_provider" NOT NULL,
	"model" text NOT NULL,
	"base_url" text,
	"api_key_encrypted" text,
	"api_key_hint" text,
	"json_mode" "llm_json_mode" DEFAULT 'schema' NOT NULL,
	"max_generations_per_hour" integer DEFAULT 30 NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_llm_settings" ADD CONSTRAINT "tenant_llm_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;

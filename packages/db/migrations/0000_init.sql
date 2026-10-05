CREATE TYPE "public"."composite_status" AS ENUM('draft', 'valid', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."crawl_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."credential_type" AS ENUM('oauth2_client_credentials', 'oauth2_password', 'api_key', 'bearer_static', 'basic');--> statement-breakpoint
CREATE TYPE "public"."drift_kind" AS ENUM('added', 'changed', 'removed', 'breaking');--> statement-breakpoint
CREATE TYPE "public"."failure_mode" AS ENUM('abort', 'partial');--> statement-breakpoint
CREATE TYPE "public"."pii_direction" AS ENUM('request', 'response', 'both');--> statement-breakpoint
CREATE TYPE "public"."pii_scope" AS ENUM('global', 'source', 'tool');--> statement-breakpoint
CREATE TYPE "public"."pii_strategy" AS ENUM('mask', 'hash', 'drop', 'tokenize');--> statement-breakpoint
CREATE TYPE "public"."policy_effect" AS ENUM('allow', 'deny');--> statement-breakpoint
CREATE TYPE "public"."source_status" AS ENUM('active', 'paused', 'error');--> statement-breakpoint
CREATE TYPE "public"."subject_type" AS ENUM('role', 'client', 'user', 'group');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."tool_kind" AS ENUM('openapi', 'manual', 'composite');--> statement-breakpoint
CREATE TYPE "public"."tool_state" AS ENUM('disabled', 'enabled', 'deprecated', 'removed');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	"action" text NOT NULL,
	"subject" text,
	"client_id" text,
	"tool_id" uuid,
	"tool_name" text,
	"decision" text,
	"status_code" integer,
	"latency_ms" integer,
	"redactions_count" integer,
	"projected_bytes_saved" integer,
	"artifact_id" uuid,
	"trace_id" text,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "composite_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tool_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"input_schema" jsonb NOT NULL,
	"steps" jsonb NOT NULL,
	"output_mapping" text,
	"failure_mode" "failure_mode" DEFAULT 'abort' NOT NULL,
	"timeout_ms" integer DEFAULT 10000 NOT NULL,
	"depends_on_tools" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" "composite_status" DEFAULT 'draft' NOT NULL,
	"validation_errors" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crawl_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"status" "crawl_status" DEFAULT 'queued' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "credential_type" NOT NULL,
	"config_encrypted" text NOT NULL,
	"rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drift_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tool_id" uuid NOT NULL,
	"kind" "drift_kind" NOT NULL,
	"diff" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pii_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scope" "pii_scope" NOT NULL,
	"scope_ref" uuid,
	"detector" text NOT NULL,
	"field_selector" text,
	"strategy" "pii_strategy" NOT NULL,
	"direction" "pii_direction" DEFAULT 'both' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_type" "subject_type" NOT NULL,
	"subject" text NOT NULL,
	"effect" "policy_effect" NOT NULL,
	"tool_pattern" text NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tool_id" uuid NOT NULL,
	"include" text[] DEFAULT '{}'::text[] NOT NULL,
	"exclude" text[] DEFAULT '{}'::text[] NOT NULL,
	"max_array_items" integer,
	"max_bytes" integer,
	"allow_agent_fields" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projections_tool_id_unique" UNIQUE("tool_id")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" "tenant_status" DEFAULT 'active' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "tool_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tool_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"spec_hash" text,
	"input_schema" jsonb NOT NULL,
	"output_schema" jsonb,
	"diff" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "tool_kind" NOT NULL,
	"source_id" uuid,
	"composite_def_id" uuid,
	"operation_key" text,
	"name" text NOT NULL,
	"title" text,
	"description" text DEFAULT '' NOT NULL,
	"operation_ref" jsonb,
	"input_schema" jsonb NOT NULL,
	"output_schema" jsonb,
	"annotations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" "tool_state" DEFAULT 'disabled' NOT NULL,
	"spec_hash" text,
	"version" integer DEFAULT 1 NOT NULL,
	"owner_team" text,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upstream_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"openapi_url" text,
	"openapi_inline" jsonb,
	"base_url" text NOT NULL,
	"credential_id" uuid,
	"crawl_schedule" text,
	"owner_team" text,
	"status" "source_status" DEFAULT 'active' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_crawl_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "virtual_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text,
	"description" text,
	"tool_selector" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "composite_definitions" ADD CONSTRAINT "composite_definitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composite_definitions" ADD CONSTRAINT "composite_definitions_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_runs" ADD CONSTRAINT "crawl_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_runs" ADD CONSTRAINT "crawl_runs_source_id_upstream_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."upstream_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drift_events" ADD CONSTRAINT "drift_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drift_events" ADD CONSTRAINT "drift_events_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pii_rules" ADD CONSTRAINT "pii_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projections" ADD CONSTRAINT "projections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projections" ADD CONSTRAINT "projections_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_versions" ADD CONSTRAINT "tool_versions_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_source_id_upstream_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."upstream_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream_sources" ADD CONSTRAINT "upstream_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream_sources" ADD CONSTRAINT "upstream_sources_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_servers" ADD CONSTRAINT "virtual_servers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_tenant_ts_idx" ON "audit_events" USING btree ("tenant_id","ts");--> statement-breakpoint
CREATE INDEX "crawl_runs_source_idx" ON "crawl_runs" USING btree ("source_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_tenant_name_uq" ON "credentials" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "drift_events_tenant_idx" ON "drift_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "pii_rules_tenant_idx" ON "pii_rules" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "policies_tenant_idx" ON "policies" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_versions_tool_version_uq" ON "tool_versions" USING btree ("tool_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "tools_tenant_name_uq" ON "tools" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "tools_source_operation_uq" ON "tools" USING btree ("source_id","operation_key") WHERE "tools"."operation_key" is not null;--> statement-breakpoint
CREATE INDEX "tools_tenant_state_idx" ON "tools" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "upstream_sources_tenant_name_uq" ON "upstream_sources" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "virtual_servers_tenant_slug_uq" ON "virtual_servers" USING btree ("tenant_id","slug");
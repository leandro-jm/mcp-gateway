CREATE TYPE "public"."user_locale" AS ENUM('en', 'pt-BR', 'es');--> statement-breakpoint
ALTER TABLE "crawl_runs" ADD COLUMN "error_key" text;--> statement-breakpoint
ALTER TABLE "crawl_runs" ADD COLUMN "error_params" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locale" "user_locale" DEFAULT 'en' NOT NULL;
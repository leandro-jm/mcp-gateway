ALTER TABLE "virtual_servers" ADD COLUMN "instructions" text;--> statement-breakpoint
ALTER TABLE "virtual_servers" ADD COLUMN "mode" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "virtual_servers" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "virtual_servers" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "virtual_servers" ADD COLUMN "owner_team" text;
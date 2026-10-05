DROP INDEX "tools_tenant_name_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "tools_tenant_effective_name_uq" ON "tools" USING btree ("tenant_id",coalesce("overrides"->>'name', "name"));
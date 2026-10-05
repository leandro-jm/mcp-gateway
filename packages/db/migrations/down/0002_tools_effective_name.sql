DROP INDEX IF EXISTS "tools_tenant_effective_name_uq";
CREATE UNIQUE INDEX "tools_tenant_name_uq" ON "tools" USING btree ("tenant_id","name");

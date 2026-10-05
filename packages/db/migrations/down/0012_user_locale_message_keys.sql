ALTER TABLE "users" DROP COLUMN IF EXISTS "locale";
ALTER TABLE "crawl_runs" DROP COLUMN IF EXISTS "error_params";
ALTER TABLE "crawl_runs" DROP COLUMN IF EXISTS "error_key";
DROP TYPE IF EXISTS "user_locale";

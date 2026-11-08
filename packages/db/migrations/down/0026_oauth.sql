DELETE FROM api_tokens WHERE kind::text = 'oauth';
DROP INDEX IF EXISTS api_tokens_grant_idx;
ALTER TABLE api_tokens DROP CONSTRAINT IF EXISTS api_tokens_oauth_grant_ck;
ALTER TABLE api_tokens DROP COLUMN IF EXISTS grant_id;
DROP TABLE IF EXISTS oauth_refresh_tokens;
DROP TABLE IF EXISTS oauth_authorization_codes;
DROP TABLE IF EXISTS oauth_grants;
DROP TABLE IF EXISTS oauth_clients;
DROP TYPE IF EXISTS oauth_client_kind;
-- o Postgres não remove valor de enum: recria o tipo sem 'oauth'
ALTER TYPE api_token_kind RENAME TO api_token_kind_old;
CREATE TYPE api_token_kind AS ENUM ('session', 'api');
ALTER TABLE api_tokens ALTER COLUMN kind DROP DEFAULT;
ALTER TABLE api_tokens ALTER COLUMN kind TYPE api_token_kind USING kind::text::api_token_kind;
ALTER TABLE api_tokens ALTER COLUMN kind SET DEFAULT 'api';
DROP TYPE api_token_kind_old;

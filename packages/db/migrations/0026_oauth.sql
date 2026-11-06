-- F20.3: Authorization Server para clientes MCP (ADR-030). Clientes (CIMD e DCR), grants usuário × cliente,
-- códigos de autorização e refresh tokens, só com o hash dos segredos. Access tokens continuam em
-- api_tokens (kind = 'oauth', ligados ao grant). Escrita à mão (ADR-006).
ALTER TYPE api_token_kind ADD VALUE IF NOT EXISTS 'oauth';
CREATE TYPE oauth_client_kind AS ENUM ('cimd', 'dcr');

CREATE TABLE oauth_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- URL do documento (CIMD) ou identificador gerado no registro (DCR)
  client_id text NOT NULL UNIQUE,
  kind oauth_client_kind NOT NULL,
  client_name text NOT NULL,
  client_uri text,
  redirect_uris text[] NOT NULL,
  application_type text NOT NULL CHECK (application_type IN ('web', 'native')),
  grant_types text[] NOT NULL DEFAULT '{authorization_code,refresh_token}',
  -- última busca do documento CIMD
  fetched_at timestamptz,
  last_used_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Autorização de um usuário a um cliente; é a família dos refresh tokens e o que aparece em "Aplicativos conectados".
CREATE TABLE oauth_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  scopes text[] NOT NULL,
  resource text NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_grants_tenant_idx ON oauth_grants (tenant_id);
CREATE INDEX oauth_grants_client_idx ON oauth_grants (client_id);
CREATE UNIQUE INDEX oauth_grants_active_uq ON oauth_grants (user_id, client_id) WHERE revoked_at IS NULL;

CREATE TABLE oauth_authorization_codes (
  code_hash text PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  resource text NOT NULL,
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_authorization_codes_grant_idx ON oauth_authorization_codes (grant_id);
CREATE INDEX oauth_authorization_codes_expires_idx ON oauth_authorization_codes (expires_at);

-- Refresh tokens rotativos: o já rotacionado fica guardado para detectar reuso (revoga a família).
CREATE TABLE oauth_refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  rotated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_refresh_tokens_grant_idx ON oauth_refresh_tokens (grant_id);
CREATE INDEX oauth_refresh_tokens_expires_idx ON oauth_refresh_tokens (expires_at);

ALTER TABLE api_tokens ADD COLUMN grant_id uuid REFERENCES oauth_grants(id) ON DELETE CASCADE;
-- comparação em texto: o valor novo do enum não pode ser usado na mesma transação em que foi criado
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_oauth_grant_ck CHECK ((kind::text = 'oauth') = (grant_id IS NOT NULL));
CREATE INDEX api_tokens_grant_idx ON api_tokens (grant_id) WHERE grant_id IS NOT NULL;

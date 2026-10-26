-- F19.3: provedor de modelo de decisão do roteador de tools (ADR-025). A chave fica criptografada com a chave do tenant. Escrita à mão (ADR-006).
CREATE TYPE decision_provider AS ENUM ('openai_decisions', 'jev');
CREATE TABLE tenant_decision_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  provider decision_provider NOT NULL,
  model text NOT NULL,
  base_url text,
  api_key_encrypted text,
  api_key_hint text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

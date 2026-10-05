-- F15.17: captura de debug opt-in (ADR-017). O conteúdo fica cifrado no S3; aqui só metadados. Escrita à mão (ADR-006).
CREATE TABLE debug_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by text NOT NULL,
  reason text NOT NULL,
  filter jsonb NOT NULL DEFAULT '{}'::jsonb,
  max_calls integer NOT NULL,
  captured_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX debug_captures_tenant_status_idx ON debug_captures (tenant_id, status, expires_at);

CREATE TABLE debug_capture_items (
  call_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  capture_id uuid NOT NULL REFERENCES debug_captures(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  object_key text NOT NULL,
  size_bytes integer NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX debug_capture_items_tenant_idx ON debug_capture_items (tenant_id, created_at);
CREATE INDEX debug_capture_items_expires_idx ON debug_capture_items (expires_at);

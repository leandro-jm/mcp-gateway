-- F18.2: UI generativa (ADR-022). Views por tool (1:1, padrão de projections) e tema por tenant. Escrita à mão (ADR-006).
CREATE TABLE tool_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tool_id uuid NOT NULL UNIQUE REFERENCES tools(id) ON DELETE CASCADE,
  views jsonb NOT NULL,
  spec_version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'suggested',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tool_views_tenant_idx ON tool_views (tenant_id, status);

CREATE TABLE tenant_themes (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  tokens jsonb NOT NULL DEFAULT '{}'::jsonb,
  tile_url text,
  tile_attribution text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

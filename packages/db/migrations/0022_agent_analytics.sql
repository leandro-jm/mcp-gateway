-- F15.21/F15.22: analytics de agente (ADR-016 §14-15). Escrita à mão (ADR-006).
CREATE TABLE agent_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type text NOT NULL,
  session_id text NOT NULL,
  session_key text NOT NULL,
  subject text NOT NULL,
  agent_name text,
  tool text NOT NULL,
  related text[] NOT NULL DEFAULT '{}',
  count integer NOT NULL,
  detail text,
  first_call_id uuid NOT NULL,
  last_call_id uuid NOT NULL,
  at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_findings_unique UNIQUE (tenant_id, type, first_call_id, tool)
);
CREATE INDEX agent_findings_tenant_at_idx ON agent_findings (tenant_id, at DESC);

CREATE TABLE tool_transitions_daily (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day date NOT NULL,
  from_tool text NOT NULL,
  to_tool text NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY (tenant_id, day, from_tool, to_tool)
);

CREATE TABLE composite_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sequence_hash text NOT NULL,
  sequence text[] NOT NULL,
  sessions integer NOT NULL,
  subjects integer NOT NULL,
  share real NOT NULL,
  status text NOT NULL DEFAULT 'open',
  composite_id uuid,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT composite_suggestions_unique UNIQUE (tenant_id, sequence_hash)
);
CREATE INDEX composite_suggestions_tenant_status_idx ON composite_suggestions (tenant_id, status);

CREATE TABLE call_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ts timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  session_key text,
  subject text NOT NULL,
  client_id text,
  agent_name text,
  virtual_server_id uuid,
  outcome text NOT NULL,
  reason_code text,
  call_ids uuid[] NOT NULL DEFAULT '{}',
  tools text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX call_outcomes_tenant_ts_idx ON call_outcomes (tenant_id, ts DESC);
CREATE INDEX call_outcomes_session_idx ON call_outcomes (tenant_id, session_key, ts DESC);

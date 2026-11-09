-- Records of processing (docs/PLAN.md P1 item 8). One row per saved version of an organisation's record. A version is never changed or
-- removed: saving again makes the next version, so the history of what an organisation said about its processing, and when, is kept.
-- The record is stored as its canonical JSON text with the SHA-256 of that text, and the database checks the hash, so a stored
-- version can be shown to be exactly what was saved. The free text can mention people, so audit entries hold the hash and not the words.

CREATE TABLE ropa_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  version integer NOT NULL CHECK (version >= 1),
  document_json text NOT NULL CHECK (length(document_json) BETWEEN 2 AND 262144 AND jsonb_typeof(document_json::jsonb) = 'object'),
  document_sha256 char(64) NOT NULL CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, version),
  CHECK (document_sha256::text = encode(sha256(convert_to(document_json, 'UTF8')), 'hex'))
);

ALTER TABLE ropa_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ropa_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ropa_versions
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- Insert and read only: the application role can never change or delete a version.
GRANT SELECT, INSERT ON ropa_versions TO saral_app;

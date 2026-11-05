-- Append-only, hash-chained audit log (docs/PLAN.md section 5.2, ADR 0002, threat model 0001).
--
-- The database enforces what it can without the HMAC key: the per-tenant sequence and the link to the previous
-- entry, the shape of every field, and immutability. The HMAC itself is computed and verified by the application
-- and the verifier (packages/audit-chain). An owner who deliberately disables a trigger is not stopped by this
-- file; the nightly Merkle anchor in S3 Object Lock is what catches that.

CREATE TABLE consent_audit_log (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  seq_no bigint NOT NULL CHECK (seq_no >= 1),
  -- Millisecond precision, because the canonical string hashes milliseconds.
  ts timestamptz NOT NULL CHECK (date_trunc('milliseconds', ts) = ts),
  actor_type text NOT NULL CHECK (actor_type IN ('principal', 'dpo', 'system')),
  actor_id text CHECK (actor_id IS NULL OR length(actor_id) BETWEEN 1 AND 128),
  action text NOT NULL CHECK (action ~ '^[a-z]+(\.[a-z_]+)+$'),
  ref_table text NOT NULL CHECK (ref_table ~ '^[a-z_]+$'),
  ref_id uuid NOT NULL,
  -- SHA-256 of the canonical string of the record the entry refers to.
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  canonical_schema_version integer NOT NULL DEFAULT 1 CHECK (canonical_schema_version >= 1),
  prev_hash char(64) NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  entry_hash char(64) NOT NULL CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
  hmac_schema_version integer NOT NULL DEFAULT 1 CHECK (hmac_schema_version >= 1),
  PRIMARY KEY (tenant_id, seq_no)
);

CREATE INDEX consent_audit_log_ref ON consent_audit_log (tenant_id, ref_table, ref_id);
CREATE INDEX consent_audit_log_ts ON consent_audit_log (tenant_id, ts);

-- Serialises appends for one tenant for the rest of the transaction. Call it before reading the head of the chain.
CREATE FUNCTION audit_append_lock(p_tenant uuid) RETURNS void
  LANGUAGE sql
  AS $$ SELECT pg_advisory_xact_lock(hashtextextended('saral.audit:' || p_tenant::text, 0)) $$;

-- Every new entry must continue its tenant's chain: seq 1 with the genesis hash first, then the next seq with
-- the previous entry's hash.
CREATE FUNCTION audit_chain_link() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  last_seq bigint;
  last_hash char(64);
BEGIN
  SELECT seq_no, entry_hash INTO last_seq, last_hash
    FROM consent_audit_log WHERE tenant_id = NEW.tenant_id ORDER BY seq_no DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.seq_no <> 1 OR NEW.prev_hash <> repeat('0', 64) THEN
      RAISE EXCEPTION 'first audit entry for a tenant must have seq_no 1 and the genesis prev_hash';
    END IF;
  ELSIF NEW.seq_no <> last_seq + 1 OR NEW.prev_hash <> last_hash THEN
    RAISE EXCEPTION 'audit entry does not follow the previous entry (expected seq_no %)', last_seq + 1;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER audit_chain_link BEFORE INSERT ON consent_audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_chain_link();

CREATE FUNCTION audit_append_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'consent_audit_log is append-only';
END
$$;

CREATE TRIGGER audit_no_update_delete BEFORE UPDATE OR DELETE ON consent_audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON consent_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();

ALTER TABLE consent_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON consent_audit_log
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

REVOKE ALL ON consent_audit_log FROM PUBLIC;
GRANT SELECT, INSERT ON consent_audit_log TO saral_app;

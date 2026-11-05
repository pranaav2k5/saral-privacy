-- Core tenant-owned tables with row-level security.
--
-- Roles: the migrations run as the database owner. The API connects as a login role that is a member of
-- saral_app and runs `SET LOCAL ROLE saral_app` and `set_config('app.tenant_id', <uuid>, true)` at the start of
-- every transaction. saral_app is not a superuser, owns nothing, and does not bypass row-level security.
-- (Superusers and BYPASSRLS roles skip every policy below, which is why tests must run as saral_app.)

-- Temporary tables could shadow real tables for code that does not pin its search_path. Nothing here needs them.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END
$$;

-- Roles are shared by every database in the cluster. If another migration creates the role at the same moment,
-- the error is ignored as long as the role exists afterwards.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'saral_app') THEN
    BEGIN
      CREATE ROLE saral_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    EXCEPTION WHEN OTHERS THEN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'saral_app') THEN
        RAISE;
      END IF;
    END;
  END IF;
END
$$;

-- The tenant of the current transaction. NULL when unset or empty, so an unset tenant matches no rows.
-- A value that is not a UUID raises an error: the query fails closed instead of returning rows.
CREATE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public, pg_temp
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per person per tenant. pseudonym_hmac is a keyed HMAC of the person's identifier and the tenant
-- (decision D12), never a plain hash. Raw phone numbers and emails do not live here.
CREATE TABLE tenant_principals (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL,
  pseudonym_hmac char(64) NOT NULL CHECK (pseudonym_hmac ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, pseudonym_hmac)
);

-- One row per language of each published notice version. Published notices are immutable: the application
-- role may insert and read them, never change or delete them, because consents bind the notice hash.
CREATE TABLE privacy_notices (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  version integer NOT NULL CHECK (version >= 1),
  language text NOT NULL CHECK (language ~ '^[a-z]{2}$'),
  canonical_text text NOT NULL,
  canonical_sha256 char(64) NOT NULL CHECK (canonical_sha256 ~ '^[0-9a-f]{64}$'),
  -- The hash is of the stored text exactly, so callers store the canonical text (packages/notice canonicalNoticeText).
  CHECK (canonical_sha256::text = encode(sha256(convert_to(canonical_text, 'UTF8')), 'hex')),
  review_status text NOT NULL DEFAULT 'pending-human-review'
    CHECK (review_status IN ('pending-human-review', 'reviewed')),
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, canonical_sha256),
  UNIQUE (tenant_id, version, language)
);

-- The composite foreign keys keep every reference inside one tenant, even for roles that bypass row-level security.
CREATE TABLE consent_records (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  principal_id uuid NOT NULL,
  notice_id uuid NOT NULL,
  notice_sha256 char(64) NOT NULL CHECK (notice_sha256 ~ '^[0-9a-f]{64}$'),
  purposes jsonb NOT NULL CHECK (jsonb_typeof(purposes) = 'array'),
  status text NOT NULL CHECK (status IN ('granted', 'withdrawn', 'expired')),
  granted_at timestamptz NOT NULL,
  withdrawn_at timestamptz,
  collection_method text NOT NULL CHECK (collection_method IN ('web_sdk', 'api', 'dpo_entry')),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES tenant_principals (tenant_id, id),
  -- Binds the consent to the exact notice text: the stored hash must be that notice's hash.
  FOREIGN KEY (tenant_id, notice_id, notice_sha256) REFERENCES privacy_notices (tenant_id, id, canonical_sha256)
);

-- A consent only ever finishes: granted to withdrawn or expired. A finished consent never changes, and nothing but
-- status and withdrawn_at changes on the way. A new consent is a new row. Applies to the owner too.
CREATE FUNCTION consent_records_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF OLD.status <> 'granted' THEN
    RAISE EXCEPTION 'consent % is % and cannot change; record a new consent instead', OLD.id, OLD.status;
  END IF;
  IF NEW.status NOT IN ('withdrawn', 'expired') THEN
    RAISE EXCEPTION 'a consent can only move from granted to withdrawn or expired';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.principal_id, NEW.notice_id, NEW.notice_sha256, NEW.purposes, NEW.granted_at, NEW.collection_method)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.principal_id, OLD.notice_id, OLD.notice_sha256, OLD.purposes, OLD.granted_at, OLD.collection_method) THEN
    RAISE EXCEPTION 'only status and withdrawn_at may change on a consent';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER consent_records_guard BEFORE UPDATE ON consent_records
  FOR EACH ROW EXECUTE FUNCTION consent_records_guard();

CREATE INDEX consent_records_principal ON consent_records (tenant_id, principal_id);

CREATE TABLE consent_receipts (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  consent_id uuid NOT NULL,
  jwt text NOT NULL,
  jwks_kid text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  FOREIGN KEY (tenant_id, consent_id) REFERENCES consent_records (tenant_id, id)
);

CREATE INDEX consent_receipts_consent ON consent_receipts (tenant_id, consent_id);

-- Row-level security: enabled and forced (so the table owner is subject to it too) on every tenant-owned table.
-- The policy has a WITH CHECK, so writes for another tenant are refused as well as reads hidden.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants FOR SELECT USING (id = current_tenant_id());

ALTER TABLE tenant_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_principals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_principals
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE privacy_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON privacy_notices
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON consent_records
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE consent_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON consent_receipts
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- Least privilege for the application role. Tenants are created by operators, not by the API.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO saral_app;
GRANT SELECT ON tenants TO saral_app;
GRANT SELECT, INSERT ON tenant_principals, privacy_notices, consent_receipts TO saral_app;
GRANT SELECT, INSERT ON consent_records TO saral_app;
-- Withdrawal and expiry change only these two columns; no one can move a row to another tenant.
GRANT UPDATE (status, withdrawn_at) ON consent_records TO saral_app;

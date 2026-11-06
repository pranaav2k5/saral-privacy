-- Staff accounts for the dashboard: password, authenticator code (MFA), recovery codes. Staff are created by operators, never
-- by the API role, which can only record sign-in progress.

-- At sign-in the tenant is known only by its slug. Naming a slug shows that one tenant row and nothing else.
CREATE POLICY slug_lookup ON tenants FOR SELECT
  USING (slug = nullif(current_setting('app.tenant_slug', true), ''));

CREATE TABLE staff_users (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  -- Lookup by email without storing it in the clear: HMAC of the lower-cased address. The address itself is sealed.
  email_blind char(64) NOT NULL CHECK (email_blind ~ '^[0-9a-f]{64}$'),
  email_sealed bytea NOT NULL CHECK (length(email_sealed) BETWEEN 30 AND 1024),
  role text NOT NULL CHECK (role IN ('tenant_admin', 'dpo')),
  -- scrypt with the pinned parameters (src/staff/password.ts). Anything else is refused.
  password_hash text NOT NULL CHECK (password_hash ~ '^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$'),
  totp_secret_sealed bytea CHECK (totp_secret_sealed IS NULL OR length(totp_secret_sealed) BETWEEN 30 AND 200),
  totp_confirmed_at timestamptz,
  -- The newest authenticator time step already accepted, so a code works once.
  last_totp_step bigint NOT NULL DEFAULT -1,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  -- Bumping it signs the person out everywhere.
  session_version integer NOT NULL DEFAULT 1 CHECK (session_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  UNIQUE (tenant_id, email_blind),
  UNIQUE (tenant_id, id),
  CHECK (totp_confirmed_at IS NULL OR totp_secret_sealed IS NOT NULL)
);

CREATE TABLE staff_recovery_codes (
  tenant_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  -- HMAC of the code. The code itself is shown once, at enrolment.
  code_hash char(64) NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  used_at timestamptz,
  PRIMARY KEY (tenant_id, staff_id, code_hash),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff_users (tenant_id, id)
);

ALTER TABLE staff_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_users
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE staff_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_recovery_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_recovery_codes
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT ON staff_users TO saral_app;
GRANT UPDATE (totp_secret_sealed, totp_confirmed_at, last_totp_step, failed_attempts, locked_until) ON staff_users TO saral_app;
GRANT SELECT, INSERT, DELETE ON staff_recovery_codes TO saral_app;
GRANT UPDATE (used_at) ON staff_recovery_codes TO saral_app;

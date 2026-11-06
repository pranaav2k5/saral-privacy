-- API keys, the tenant's controller profile, per-notice purpose definitions, and narrow public reads.

-- Who the tenant is as a data fiduciary, for consent receipts (Kantara piiControllers, policyUrl, service name):
-- { "controller": { ...PiiController }, "policyUrl": "https://...", "service": "..." }. Set by operators, read-only for the API.
ALTER TABLE tenants ADD COLUMN profile jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(profile) = 'object');

-- What each purpose in a notice means, fixed when the notice is published:
-- [ { "key", "purpose", "purposeCategory": [], "piiCategory": [], "termination", "retentionDays",
--     "thirdPartyDisclosure", "thirdPartyName"?, "primaryPurpose"? } ]
-- The API takes retention and receipt details from here, never from the caller.
ALTER TABLE privacy_notices ADD COLUMN purpose_definitions jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(purpose_definitions) = 'array');

-- A published notice is public by design (its URL goes in the receipt). The application role can read the one
-- notice whose id it names, without naming a tenant.
CREATE POLICY public_notice ON privacy_notices FOR SELECT
  USING (id = nullif(current_setting('app.public_notice_id', true), '')::uuid);

-- Only an HMAC of the secret part is stored (keyed with a server pepper), so a copy of this table cannot be used as keys.
CREATE TABLE api_keys (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  kind text NOT NULL CHECK (kind IN ('publishable', 'secret')),
  scopes text[] NOT NULL
    CHECK (cardinality(scopes) >= 1 AND scopes <@ ARRAY['sdk', 'tenant_admin', 'dpo', 'auditor']),
  secret_hmac char(64) NOT NULL CHECK (secret_hmac ~ '^[0-9a-f]{64}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- For publishable keys used from a browser: the origins allowed to use the key. Empty means no restriction.
  allowed_origins text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (kind <> 'publishable' OR scopes = ARRAY['sdk'])
);

CREATE INDEX api_keys_tenant ON api_keys (tenant_id);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
-- The key to check is named by the request (app.api_key_id) before the tenant is known. Only that row is visible.
CREATE POLICY key_lookup ON api_keys FOR SELECT
  USING (id = nullif(current_setting('app.api_key_id', true), '')::uuid);

GRANT SELECT ON api_keys TO saral_app;

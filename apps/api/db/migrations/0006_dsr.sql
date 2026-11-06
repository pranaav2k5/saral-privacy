-- Data-principal rights requests, the encrypted contacts needed to answer them, and the events they raise.

-- The only place a raw phone number or email address is kept, sealed with AES-256-GCM (src/crypto/contact-crypto.ts) so a
-- data protection officer can answer a request. Deleted when an erasure request is fulfilled.
CREATE TABLE principal_contacts (
  tenant_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  sealed bytea NOT NULL CHECK (length(sealed) BETWEEN 30 AND 1024),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, principal_id),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES tenant_principals (tenant_id, id)
);

-- One request from a person: access, correction, erasure, nomination or grievance. `details` is free text written by the
-- person, so it can hold personal data; it is limited in size and never copied into audit entries or webhooks.
CREATE TABLE dsr_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  principal_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('access', 'correction', 'erasure', 'nomination', 'grievance')),
  state text NOT NULL DEFAULT 'submitted'
    CHECK (state IN ('submitted', 'identity_pending', 'in_review', 'fulfilled', 'rejected', 'closed')),
  details text CHECK (details IS NULL OR length(details) <= 2000),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  decided_reason text CHECK (decided_reason IS NULL OR length(decided_reason) <= 500),
  closed_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES tenant_principals (tenant_id, id)
);

CREATE INDEX dsr_requests_queue ON dsr_requests (tenant_id, state, due_at);

-- The legal moves, enforced here as well as in the application (a test compares all 36 pairs with src/dsr/state.ts).
-- Only state, the reason and the closing time ever change, and a rejection needs a reason. Applies to the owner too.
CREATE FUNCTION dsr_requests_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.principal_id, NEW.type, NEW.details, NEW.submitted_at, NEW.due_at)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.principal_id, OLD.type, OLD.details, OLD.submitted_at, OLD.due_at) THEN
    RAISE EXCEPTION 'only state, decided_reason and closed_at may change on a rights request';
  END IF;
  IF NOT (
    (OLD.state = 'submitted' AND NEW.state IN ('identity_pending', 'in_review', 'rejected')) OR
    (OLD.state = 'identity_pending' AND NEW.state IN ('in_review', 'rejected')) OR
    (OLD.state = 'in_review' AND NEW.state IN ('fulfilled', 'rejected')) OR
    (OLD.state IN ('fulfilled', 'rejected') AND NEW.state = 'closed')
  ) THEN
    RAISE EXCEPTION 'illegal rights request transition from % to %', OLD.state, NEW.state;
  END IF;
  IF NEW.state = 'rejected' AND (NEW.decided_reason IS NULL OR btrim(NEW.decided_reason) = '') THEN
    RAISE EXCEPTION 'a rejection needs a reason';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER dsr_requests_guard BEFORE UPDATE ON dsr_requests
  FOR EACH ROW EXECUTE FUNCTION dsr_requests_guard();

ALTER TABLE principal_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE principal_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON principal_contacts
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE dsr_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE dsr_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON dsr_requests
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, DELETE ON principal_contacts TO saral_app;
GRANT UPDATE (sealed) ON principal_contacts TO saral_app;
GRANT SELECT, INSERT ON dsr_requests TO saral_app;
GRANT UPDATE (state, decided_reason, closed_at) ON dsr_requests TO saral_app;
-- Erasure unlinks a person from their identifier by replacing the pseudonym with a random value (docs/PLAN.md section 5.2).
GRANT UPDATE (pseudonym_hmac) ON tenant_principals TO saral_app;

-- The new events.
ALTER TABLE webhook_endpoints DROP CONSTRAINT webhook_endpoints_events_check;
ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_events_check
  CHECK (cardinality(events) >= 1 AND events <@ ARRAY['consent.granted', 'consent.withdrawn', 'dsr.submitted', 'dsr.transitioned']);
ALTER TABLE webhook_deliveries DROP CONSTRAINT webhook_deliveries_event_type_check;
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_event_type_check
  CHECK (event_type IN ('consent.granted', 'consent.withdrawn', 'dsr.submitted', 'dsr.transitioned'));

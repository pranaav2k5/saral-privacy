-- Webhook endpoints and the delivery outbox.
--
-- A delivery row is written in the same transaction as the event that caused it, so an event is never delivered
-- without being recorded and never recorded without being queued. A separate role, saral_worker, sends deliveries:
-- it can see due deliveries of every tenant (the application role cannot), and nothing else in the database.
-- Signing secrets are not stored. Each one is derived from a server key, the endpoint id and secret_version.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'saral_worker') THEN
    BEGIN
      CREATE ROLE saral_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    EXCEPTION WHEN OTHERS THEN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'saral_worker') THEN
        RAISE;
      END IF;
    END;
  END IF;
END
$$;

CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  url text NOT NULL CHECK (url ~ '^https://' AND length(url) <= 500),
  events text[] NOT NULL
    CHECK (cardinality(events) >= 1 AND events <@ ARRAY['consent.granted', 'consent.withdrawn']),
  secret_version integer NOT NULL DEFAULT 1 CHECK (secret_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  UNIQUE (tenant_id, id)
);

CREATE TABLE webhook_deliveries (
  -- Also the idempotency key the receiver sees.
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  endpoint_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('consent.granted', 'consent.withdrawn')),
  -- Ids and states only. Never a phone number, email or name.
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 15),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status integer,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  FOREIGN KEY (tenant_id, endpoint_id) REFERENCES webhook_endpoints (tenant_id, id)
);

CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE state = 'pending';
CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries (tenant_id, endpoint_id, created_at);

ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook_endpoints
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY worker_read ON webhook_endpoints FOR SELECT TO saral_worker USING (true);

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook_deliveries
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY worker_access ON webhook_deliveries FOR SELECT TO saral_worker USING (true);
CREATE POLICY worker_update ON webhook_deliveries FOR UPDATE TO saral_worker USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON webhook_endpoints TO saral_app;
GRANT UPDATE (disabled_at, secret_version) ON webhook_endpoints TO saral_app;
GRANT SELECT, INSERT ON webhook_deliveries TO saral_app;

GRANT USAGE ON SCHEMA public TO saral_worker;
GRANT SELECT ON webhook_endpoints TO saral_worker;
GRANT SELECT ON webhook_deliveries TO saral_worker;
GRANT UPDATE (state, attempts, next_attempt_at, last_status, last_error, delivered_at) ON webhook_deliveries TO saral_worker;

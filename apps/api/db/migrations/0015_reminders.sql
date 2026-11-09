-- Reminders that reach a person who has not opened the dashboard. A job looks at each organisation's breaches (the Board not yet
-- told, the deadline within 24 hours or passed) and at the newest version of its record of processing (the next review within 14
-- days or overdue), and sends a webhook event to the endpoints that asked for it. This migration adds the four event names and the
-- table that makes each reminder go out once.
--
-- A reminder is "sent" only when at least one endpoint was queued for it, so an organisation that has no endpoint yet is reminded
-- once it adds one. The row is written in the same transaction as the deliveries it stands for. `ref_id` is the id of an incident or of
-- a version of the record: a different table for each kind, so it carries no foreign key. A new version of the record is a new
-- thing to remind about, which is what gives an organisation its reminders again after it reviews the record.

ALTER TABLE webhook_endpoints DROP CONSTRAINT webhook_endpoints_events_check;
ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_events_check
  CHECK (cardinality(events) >= 1 AND events <@ ARRAY[
    'consent.granted', 'consent.withdrawn', 'dsr.submitted', 'dsr.transitioned',
    'breach.deadline_soon', 'breach.deadline_passed', 'ropa.review_soon', 'ropa.review_overdue']);
ALTER TABLE webhook_deliveries DROP CONSTRAINT webhook_deliveries_event_type_check;
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_event_type_check
  CHECK (event_type IN (
    'consent.granted', 'consent.withdrawn', 'dsr.submitted', 'dsr.transitioned',
    'breach.deadline_soon', 'breach.deadline_passed', 'ropa.review_soon', 'ropa.review_overdue'));

CREATE TABLE reminders_sent (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  kind text NOT NULL CHECK (kind IN ('breach', 'ropa')),
  ref_id uuid NOT NULL,
  stage text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, ref_id, stage),
  CHECK ((kind = 'breach' AND stage IN ('soon', 'passed')) OR (kind = 'ropa' AND stage IN ('soon', 'overdue')))
);

ALTER TABLE reminders_sent ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminders_sent FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reminders_sent
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON reminders_sent TO saral_app;

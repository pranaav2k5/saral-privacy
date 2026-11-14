-- Personal data breach incidents (docs/PLAN.md P1 item 9). One row per incident, from the first report to the closing note.
-- `description` and the other free-text fields are written by staff and can mention people, so they are limited in size and are
-- never copied into audit entries (an entry holds a hash of the content, not the content).
--
-- An incident moves one way: reported, signed_off (the data protection officer signed off the drafts, whose hashes are kept),
-- board_notified (the Board was told, with the reference it gave), closed (with a note, after the affected people were told).
-- What was reported can be corrected only until sign-off. Each step's facts are written once and never change. The application
-- role can never delete an incident. All of this is enforced here, and applies to the owner too.

CREATE TABLE breach_incidents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  state text NOT NULL DEFAULT 'reported' CHECK (state IN ('reported', 'signed_off', 'board_notified', 'closed')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 4000),
  discovered_at timestamptz NOT NULL,
  occurred_at timestamptz CHECK (occurred_at IS NULL OR occurred_at <= discovered_at),
  nature text[] NOT NULL CHECK (cardinality(nature) BETWEEN 1 AND 3 AND nature <@ ARRAY['confidentiality', 'integrity', 'availability']),
  data_categories text[] NOT NULL CHECK (cardinality(data_categories) BETWEEN 1 AND 20),
  approx_principals integer CHECK (approx_principals IS NULL OR approx_principals BETWEEN 0 AND 1000000000),
  likely_consequences text NOT NULL CHECK (length(btrim(likely_consequences)) BETWEEN 1 AND 2000),
  measures_taken text NOT NULL CHECK (length(btrim(measures_taken)) BETWEEN 1 AND 2000),
  reported_at timestamptz NOT NULL DEFAULT now(),
  reported_by text NOT NULL CHECK (length(reported_by) BETWEEN 1 AND 100),
  signed_off_at timestamptz,
  signed_off_by text CHECK (signed_off_by IS NULL OR length(signed_off_by) BETWEEN 1 AND 100),
  signed_off_board_sha256 char(64) CHECK (signed_off_board_sha256 IS NULL OR signed_off_board_sha256 ~ '^[0-9a-f]{64}$'),
  signed_off_principal_sha256 char(64) CHECK (signed_off_principal_sha256 IS NULL OR signed_off_principal_sha256 ~ '^[0-9a-f]{64}$'),
  board_notified_at timestamptz,
  board_reference text CHECK (board_reference IS NULL OR length(btrim(board_reference)) BETWEEN 1 AND 200),
  principals_notified_at timestamptz,
  principals_how text CHECK (principals_how IS NULL OR length(btrim(principals_how)) BETWEEN 1 AND 1000),
  principals_count integer CHECK (principals_count IS NULL OR principals_count BETWEEN 0 AND 1000000000),
  closed_at timestamptz,
  closing_note text CHECK (closing_note IS NULL OR length(btrim(closing_note)) BETWEEN 1 AND 2000),
  UNIQUE (tenant_id, id),
  -- The facts of a step exist exactly when the incident has reached that step.
  CHECK ((state <> 'reported') = (signed_off_at IS NOT NULL AND signed_off_by IS NOT NULL AND signed_off_board_sha256 IS NOT NULL AND signed_off_principal_sha256 IS NOT NULL)),
  CHECK ((signed_off_at IS NULL) = (signed_off_by IS NULL)),
  CHECK ((state IN ('board_notified', 'closed')) = (board_notified_at IS NOT NULL AND board_reference IS NOT NULL)),
  CHECK ((board_notified_at IS NULL) = (board_reference IS NULL)),
  CHECK ((principals_notified_at IS NULL) = (principals_how IS NULL) AND (principals_how IS NULL) = (principals_count IS NULL)),
  -- The affected people are told after sign-off, and before the incident is closed.
  CHECK (principals_notified_at IS NULL OR state <> 'reported'),
  CHECK ((state = 'closed') = (closed_at IS NOT NULL AND closing_note IS NOT NULL)),
  CHECK (state <> 'closed' OR principals_notified_at IS NOT NULL)
);

CREATE INDEX breach_incidents_queue ON breach_incidents (tenant_id, state, discovered_at);

CREATE FUNCTION breach_incidents_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'reported' THEN
      RAISE EXCEPTION 'a breach incident starts as reported';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.tenant_id, NEW.reported_at, NEW.reported_by) IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.reported_at, OLD.reported_by) THEN
    RAISE EXCEPTION 'who reported a breach, and when, cannot change';
  END IF;

  IF OLD.state <> 'reported'
     AND (NEW.title, NEW.description, NEW.discovered_at, NEW.occurred_at, NEW.nature, NEW.data_categories, NEW.approx_principals, NEW.likely_consequences, NEW.measures_taken)
         IS DISTINCT FROM
         (OLD.title, OLD.description, OLD.discovered_at, OLD.occurred_at, OLD.nature, OLD.data_categories, OLD.approx_principals, OLD.likely_consequences, OLD.measures_taken) THEN
    RAISE EXCEPTION 'a breach record cannot change once it has been signed off';
  END IF;

  IF NEW.state <> OLD.state AND NOT (
    (OLD.state = 'reported' AND NEW.state = 'signed_off') OR
    (OLD.state = 'signed_off' AND NEW.state = 'board_notified') OR
    (OLD.state = 'board_notified' AND NEW.state = 'closed')
  ) THEN
    RAISE EXCEPTION 'illegal breach incident transition from % to %', OLD.state, NEW.state;
  END IF;

  -- Each step's facts are written by the move into that step, once, and never change.
  IF (NEW.signed_off_at, NEW.signed_off_by, NEW.signed_off_board_sha256, NEW.signed_off_principal_sha256)
     IS DISTINCT FROM (OLD.signed_off_at, OLD.signed_off_by, OLD.signed_off_board_sha256, OLD.signed_off_principal_sha256)
     AND NOT (OLD.state = 'reported' AND NEW.state = 'signed_off') THEN
    RAISE EXCEPTION 'the sign-off is written once, when the incident is signed off';
  END IF;
  IF (NEW.board_notified_at, NEW.board_reference) IS DISTINCT FROM (OLD.board_notified_at, OLD.board_reference)
     AND NOT (OLD.state = 'signed_off' AND NEW.state = 'board_notified') THEN
    RAISE EXCEPTION 'the notice to the Board is written once, when it is recorded';
  END IF;
  IF (NEW.closed_at, NEW.closing_note) IS DISTINCT FROM (OLD.closed_at, OLD.closing_note)
     AND NOT (OLD.state = 'board_notified' AND NEW.state = 'closed') THEN
    RAISE EXCEPTION 'the closing note is written once, when the incident is closed';
  END IF;
  IF (NEW.principals_notified_at, NEW.principals_how, NEW.principals_count)
     IS DISTINCT FROM (OLD.principals_notified_at, OLD.principals_how, OLD.principals_count)
     AND NOT (OLD.principals_notified_at IS NULL AND OLD.state IN ('signed_off', 'board_notified') AND NEW.state = OLD.state) THEN
    RAISE EXCEPTION 'the notice to the affected people is written once, after sign-off and before the incident is closed';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER breach_incidents_guard BEFORE INSERT OR UPDATE ON breach_incidents
  FOR EACH ROW EXECUTE FUNCTION breach_incidents_guard();

ALTER TABLE breach_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE breach_incidents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON breach_incidents
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- No DELETE: an incident is a record that is kept.
GRANT SELECT, INSERT ON breach_incidents TO saral_app;
GRANT UPDATE (state, title, description, discovered_at, occurred_at, nature, data_categories, approx_principals, likely_consequences, measures_taken,
              signed_off_at, signed_off_by, signed_off_board_sha256, signed_off_principal_sha256, board_notified_at, board_reference,
              principals_notified_at, principals_how, principals_count, closed_at, closing_note)
  ON breach_incidents TO saral_app;

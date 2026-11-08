-- The nightly anchor job must know which organisations exist, and nothing else about them. The role it runs as can read the
-- id column of tenants (every row) and nothing more: no name, no profile, and no table of any organisation's data. The job
-- reads each organisation's audit chain the usual way, as the application role scoped to that organisation, so row-level
-- security applies to it exactly as it does to a request.
--
-- The process connects with one login and switches to this role with SET LOCAL ROLE, as it does for saral_app and saral_worker.
-- The database owner or a superuser can do that. Any other login needs, once: GRANT saral_app, saral_worker, saral_anchor TO <login>;
-- (this file cannot do it, because it does not know the login's name). Without it the nightly job stops before it reads any
-- organisation, writes no anchors, and exits with an error.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'saral_anchor') THEN
    BEGIN
      CREATE ROLE saral_anchor NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    EXCEPTION WHEN OTHERS THEN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'saral_anchor') THEN
        RAISE;
      END IF;
    END;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO saral_anchor;
GRANT SELECT (id) ON tenants TO saral_anchor;
CREATE POLICY anchor_list ON tenants FOR SELECT TO saral_anchor USING (true);

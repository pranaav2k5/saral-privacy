-- The nightly anchor job must know which organisations exist, and nothing else about them. The role it runs as can read the
-- id column of tenants (every row) and nothing more: no name, no profile, and no table of any organisation's data. The job
-- reads each organisation's audit chain the usual way, as the application role scoped to that organisation, so row-level
-- security applies to it exactly as it does to a request.

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

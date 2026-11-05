# ADR 0003: Database schema, tenancy and the audit table

Status: accepted
Date: 2026-11-06

## Context

`docs/PLAN.md` section 5 calls for one shared PostgreSQL 16 database with row-level security on every tenant-owned table, and for an append-only audit log. The Feasibility Study gives a draft schema (its section 3.5). Building it showed several places where the draft should change.

## Decision

- Plain SQL migrations in `apps/api/db/migrations`, applied by a 60-line runner (`src/db/migrate.ts`) that records each file's SHA-256 and refuses edited files. No ORM or migration framework yet; revisit when the schema needs generated types.
- The API will connect as a login role that is a member of `saral_app` and run `SET LOCAL ROLE saral_app` and `set_config('app.tenant_id', ..., true)` inside a transaction per request. `saral_app` is not a superuser, owns nothing, and does not bypass row-level security. Row-level security is `FORCE`d.
- Differences from the Feasibility Study draft:
  - No `principals` (cross-tenant wallet) table. The wallet is P2. `tenant_principals` has a UUID `id` (the id used in canonical strings) and `pseudonym_hmac`, a keyed HMAC (decision D12).
  - `privacy_notices` has one row per language of each version, with `review_status`, instead of a `languages` JSON column.
  - `consent_records` drops `ip_hash` and `device_fingerprint`: both are personal data and nothing needs them yet. Adding them back needs a purpose, a retention period and a RoPA entry.
  - Composite foreign keys `(tenant_id, id)` keep references inside one tenant.
  - `consent_audit_log` is keyed `(tenant_id, seq_no)`, not by a global sequence; `payload_sha256` is added (ADR 0002); timestamps must have millisecond precision; the database enforces the chain link (next `seq_no`, previous hash).
  - The application role gets only the privileges it needs: no update or delete on notices, receipts or audit entries, and `UPDATE` on two columns of `consent_records`.
- Tests create a throwaway database per test file and run as `saral_app`. Without `DATABASE_URL` they fail, they never skip.

## Consequences

- CI needs a PostgreSQL service, and `pnpm verify` needs a running database (`pnpm db:up`).
- Adding a tenant-owned table means adding RLS, a policy with a write check, grants, and a place in the test's table list. The test that scans for a `tenant_id` column catches a table that skips this.
- The audit triggers stop mistakes and application bugs. They do not stop an owner who drops them; the nightly anchor does.
- Revisit the migration runner if more than one service migrates the same database, or when RDS and a separate role-provisioning step exist.

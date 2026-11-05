# Threat model 0003: tenancy boundary (row-level security) and audit table protections

Status: draft, covers the database schema in `apps/api/db/migrations`. The API's per-request tenant handling (Task 8 in the plan) extends it. The tenancy boundary is the main penetration-test target (`docs/PLAN.md` section 5.2).

## Scope

In scope: PostgreSQL row-level security on every tenant-owned table, the roles and grants, cross-tenant references, and the audit table's insert-only and chain rules. Out of scope for now: how the API decides which tenant a request belongs to, connection pooling behaviour, backups, and replicas.

## Assets

Every tenant's consents, notices, receipts and audit entries. A leak between tenants, or a silent edit of the audit log, would end the product.

## Trust boundaries

API process to database; one tenant to another; the application role to the database owner.

## Threats

| STRIDE | Threat | Mitigation | Proof |
|---|---|---|---|
| Information disclosure | One tenant reads another's rows. | Row-level security with `FORCE`, policy `tenant_id = current_tenant_id()` on every tenant-owned table. | `rls.test.ts`: each table, as the application role |
| Information disclosure | The tenant setting is missing, empty or wrong, and the query returns everything. | `current_tenant_id()` returns NULL for unset or empty, which matches no rows. A malformed value raises an error. Both fail closed. | `rls.test.ts`: unset, empty, malformed |
| Tampering | A write is made for another tenant, or a row is moved to another tenant. | `WITH CHECK` on every policy; `UPDATE` is granted on two columns of `consent_records` only (`status`, `withdrawn_at`). | `rls.test.ts`: cross-tenant insert, move |
| Elevation of privilege | Tests or code run as a superuser or table owner, so row-level security is skipped and every test passes for the wrong reason. | Tests switch to `saral_app` and assert that it is not a superuser, does not bypass row-level security and owns no table. The role is `NOINHERIT` and is never given ownership. | `rls.test.ts`: first two tests |
| Elevation of privilege | A table is added without row-level security. | A test lists every table with a `tenant_id` column and fails if any lacks enabled and forced security or a write check. | `rls.test.ts`: "every tenant-owned table" |
| Tampering | A reference crosses tenants (a consent pointing at another tenant's notice), which row-level security alone does not stop because foreign-key checks run as the owner. | Composite foreign keys `(tenant_id, id)`. | `rls.test.ts`: references cannot cross tenants |
| Tampering | A consent is flipped back from withdrawn to granted, or its other columns are changed, by a bug or a compromised API. | A guard trigger allows only granted to withdrawn or expired, freezes finished consents, and allows only `status` and `withdrawn_at` to change; a re-grant is a new row. It applies to the owner too. | `integrity.test.ts`: "a consent can only finish" |
| Tampering | A consent claims a notice hash that is not the notice's real hash. | `privacy_notices.canonical_sha256` must equal the SHA-256 of the stored text (CHECK), and `consent_records` references `(tenant_id, notice_id, notice_sha256)` as a composite foreign key. | `integrity.test.ts`: "bound to the exact notice text" |
| Elevation of privilege | SQL run as the application role shadows a table or function through a temporary table or the search path (for example a fake `consent_audit_log` read by the chain trigger). | Every function pins `search_path = pg_catalog, public, pg_temp`; the chain trigger schema-qualifies its table; `TEMPORARY` is revoked from `PUBLIC` on the database. Exploiting this first needs arbitrary SQL as `saral_app`, so it is defence in depth. | `integrity.test.ts`: search path |
| Tampering | A published notice is edited after consents bound its hash. | The application role has no `UPDATE` or `DELETE` on `privacy_notices` or `consent_receipts`. | `rls.test.ts`: least privilege |
| Tampering | An audit entry is updated, deleted or truncated. | No such privileges for the application role; triggers raise for everyone, including the owner. | `audit-immutability.test.ts` |
| Tampering | The audit chain is forked or has gaps because two appends raced. | A trigger requires the next `seq_no` and the previous entry's hash; `audit_append_lock` serialises appends per tenant; the primary key is `(tenant_id, seq_no)`. | `audit-immutability.test.ts`: link rules, stale head, 20 concurrent appends |
| Tampering | The owner disables a trigger and edits a row. | Not prevented. Detected by `verifyChain` and by the nightly anchor (threat model 0001). | `audit-immutability.test.ts`: owner edit is caught |
| Information disclosure | The audit log holds personal data. | Columns are ids, hashes and metadata. `actor_id` is 1 to 128 characters and must never hold an email or phone number (rule for the API task). | schema review |
| Denial of service | One tenant's long transaction holds the audit lock and stalls its own appends. | The lock is per tenant and transaction-scoped. Other tenants are unaffected. | design |
| Repudiation | A migration is edited after it was applied. | The runner stores each file's SHA-256 and refuses to continue if it changed. | `migrate.test.ts` |

## Residual risks

- Connection pooling: `set_config('app.tenant_id', ..., true)` is transaction-local, and the API must open a transaction per request. A pooler in statement mode would break this. Decide and test when the API is built.
- The shared `saral_app` role means a bug in the API's tenant selection exposes the chosen tenant only; it does not widen access. A wrong tenant id is still a wrong-tenant read, so the API task needs its own tests.
- Rows removed from the tail of an audit chain by an owner are visible only against the anchor.
- The migration creates the cluster-wide `saral_app` role, which needs `CREATEROLE` in production. Move role creation into infrastructure code when RDS is added.

Owner of residual risk: repository owner (`pranaav2k5`). Review again with the consent API and before the first external penetration test.

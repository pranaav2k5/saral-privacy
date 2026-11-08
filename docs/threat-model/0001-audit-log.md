# Threat model 0001: tamper-evident audit log

Status: draft, covers the library and the `saral-audit-verify` command in `packages/audit-chain`, and the nightly job, the folder store and the `saral_anchor` role in `apps/api` (migration 0011). The database tables are threat model 0003. The S3 Object Lock store is not built and will extend this model.

## Scope

In scope: the canonical string (ADR 0002), the per-tenant HMAC hash chain, the RFC 6962 Merkle tree over a day's entry hashes, the anchor object written to S3 with Object Lock, and verification. Out of scope for now: the Postgres tables and triggers (threat model 0003), key storage in KMS, and the receipt signing key (threat model 0002).

## Assets

- The order and content of audit entries (evidence that a consent was given or withdrawn, and when).
- The HMAC key used by the chain.
- The daily anchor objects.

## Trust boundaries

Application server to database; application server to KMS; application to S3; an auditor or data principal to the verifier (the verifier must not need to trust us).

## Threats

| STRIDE | Threat | Mitigation | Proof |
|---|---|---|---|
| Tampering | Someone edits a field of a stored entry. | Every field is covered by the HMAC; recomputation reports the first bad `seqNo`. | `chain.test.ts`: editing each field of the third entry |
| Tampering | Someone deletes or reorders rows in the middle. | `seqNo` must be contiguous and each `prevHash` must equal the previous hash. | `chain.test.ts`: deletion, swap, repeat |
| Tampering | Someone deletes the newest rows. The chain still verifies. | The nightly anchor stores count, last `seqNo`, head hash and Merkle root, and verification compares against it. | `anchor.test.ts`: truncation passes `verifyChain` and fails against the anchor |
| Tampering | An insider with the HMAC key rewrites history and re-seals the chain. | The anchor lives in S3 with Object Lock (Compliance mode in production), outside the application's write path. A re-sealed chain no longer matches the root. | `anchor.test.ts`: rewrite with the real key is caught |
| Tampering | The stored anchor of a day is replaced, or the job is run again after the database was changed. | The store never replaces an object (`putIfAbsent` links a temporary file into place); a repeat run compares and reports `anchor_conflict` without writing. Files are made read-only. A folder is only a stand-in for Object Lock, which is what stops a person with disk access. | `anchor-job.e2e.test.ts` (conflict, repeat), `object-store.test.ts` |
| Tampering | The tail of an anchored day is removed and later entries follow from what is left, so the chain verifies and the next anchor looks clean. | Each day is checked against the latest stored earlier anchor: next number and head hash must match, else `broken_link` and nothing is written. A day that is empty in the database but has a stored anchor is an `anchor_conflict`. | `anchor-job.e2e.test.ts`: continuity, empty day |
| Tampering | An entry stamped inside a day is committed after the job read the day, so the anchor is incomplete and later checks fail. | The job takes the organisation's append lock before it reads, which an in-flight append holds until it commits. | `anchor-job.e2e.test.ts`: in-flight append |
| Tampering | A link in the store makes the job read a file from elsewhere as an anchor, or write outside the folder. | Keys are validated, a link on the way is refused before any folder is made, an object that is itself a link is refused when read (`O_NOFOLLOW`), and a write goes through a temporary file that is removed on failure. | `object-store.test.ts` |
| Tampering | A chain that no longer verifies is anchored, which would make the damage look like the truth. | The job verifies each chain before anchoring, reports the failing entry, writes nothing for that organisation and still anchors the others. | `anchor-job.e2e.test.ts`: a broken chain |
| Spoofing | An auditor is shown entries that are not the anchored ones. | `saral-audit-verify` checks count, contiguous numbers, every link, head hash and Merkle root against the anchor without a key, and also each entry's HMAC with the key. A previous anchor from another organisation or a different day is refused. | `links.test.ts`, `verify-cli.test.ts` |
| Information disclosure | The export or the job leaks personal data or another organisation's entries. | Entries hold hashes, ids, times, actor and action only; the export is scoped to the caller's organisation by row-level security; the job's role can read only organisation ids; a test looks for the phone numbers used. | `audit-export.e2e.test.ts`, `anchor-role.test.ts` |
| Elevation of privilege | The job's database role reads or changes more than it needs. | `saral_anchor` can select `tenants.id` and nothing else, and write nothing; the chains are read as the application role scoped to each organisation. | `anchor-role.test.ts` |
| Tampering | A second-preimage trick passes an inner Merkle node as a leaf, or a duplicated last leaf yields the same root. | RFC 6962 prefixes and unbalanced split. | `merkle.test.ts`: inner node, `[a,b,c]` vs `[a,b,c,c]` |
| Tampering | Two different records produce the same canonical string. | JSON array encoding with strict field validation. | `canonical.test.ts` ambiguity tests |
| Spoofing | An entry sealed with a different key is inserted. | Verification recomputes with the key for the entry's `hmacSchemaVersion`. | `chain.test.ts`: forged entry |
| Repudiation | An actor denies an action. | Actor type and id are part of the hashed fields. Weak where the actor is `system`. | covered by field-edit tests |
| Information disclosure | The log leaks personal data. | Entries hold pseudonymous ids and event metadata only. The consent content enters only as a SHA-256 (`payloadSha256`). | enforced by `AuditFields` having no free-text fields beyond `actorId` (1 to 128 characters) |
| Denial of service | Verifying a very large day is slow. | Verification is linear; the Merkle recursion is logarithmic in depth. Benchmark in week 8 per `docs/PLAN.md`. | not yet measured |
| Elevation of privilege | Replaying an old anchor to hide new rows. | The anchor is bound to a tenant, date, count and head hash. Detecting a stale anchor needs the next day's anchor to chain from it, which the nightly job must enforce. | open item for the nightly job |
| Key compromise | The HMAC key leaks. | Key held in KMS or Vault, never logged, versioned by `hmacSchemaVersion` for rotation. The anchor limits the damage to the time since the last anchor. | open item for the KMS adapter |
| Tampering | A leaked retired key is used to append entries labelled with the old `hmacSchemaVersion` after a rotation. The label is not part of the MAC. | Key versions may not decrease along the chain (`key_version_regression`), also across daily segments through `startHmacSchemaVersion`. Each version must use an independent random key, and retired keys must be disabled for signing in KMS. | `chain.test.ts`: key rotation |

## Residual risks

- Rows deleted from the tail since the last anchor are undetectable until the next anchor is written (a window of at most one day), and then only if later entries exist: the job checks each day against the latest stored anchor, so a removed tail that new entries cover is reported as `broken_link`. If nothing is appended afterwards, only a repeat run for that day (an `anchor_conflict`) or the standalone check against the stored anchor shows it.
- Without the HMAC key `saral-audit-verify` proves that the entries are the anchored ones, in order, but not that a field was left alone when the stored hashes were kept; the key is needed for that, and an outside auditor does not have it. A person who changes a field and keeps the hashes would be caught only by someone who holds the key.
- The anchors are only as good as where they are kept. A folder on the same host protects against mistakes, not against someone with that disk; production needs S3 Object Lock (Compliance mode), which is not built, and a schedule that runs the job daily and alerts on a non-zero exit code.
- A day with more than 100,000 entries for one organisation is reported as a read error and not anchored; such a day needs a streaming reader.
- The job anchors a day only after it has ended in UTC, but a clock set wrongly on the host could run it early; the job refuses a day that is not over by its own clock.
- A Merkle inclusion proof binds a leaf to a root but not the tree size; the anchor's `count` pins the size.
- Erasure versus an immutable log is a legal question (see `docs/PLAN.md` section 5.2). The design deletes the identifier-to-pseudonym mapping and leaves the chain intact. A lawyer must confirm this.

Owner of residual risk: repository owner (`pranaav2k5`). Review again when the database and nightly job exist.

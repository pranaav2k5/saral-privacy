# Threat model 0001: tamper-evident audit log

Status: draft, covers the library built in `packages/audit-chain`. The database, nightly job, S3 anchor and `/v1/audit/verify` endpoint are added later and extend this model.

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
| Tampering | A second-preimage trick passes an inner Merkle node as a leaf, or a duplicated last leaf yields the same root. | RFC 6962 prefixes and unbalanced split. | `merkle.test.ts`: inner node, `[a,b,c]` vs `[a,b,c,c]` |
| Tampering | Two different records produce the same canonical string. | JSON array encoding with strict field validation. | `canonical.test.ts` ambiguity tests |
| Spoofing | An entry sealed with a different key is inserted. | Verification recomputes with the key for the entry's `hmacSchemaVersion`. | `chain.test.ts`: forged entry |
| Repudiation | An actor denies an action. | Actor type and id are part of the hashed fields. Weak where the actor is `system`. | covered by field-edit tests |
| Information disclosure | The log leaks personal data. | Entries hold pseudonymous ids and event metadata only. The consent content enters only as a SHA-256 (`payloadSha256`). | enforced by `AuditFields` having no free-text fields beyond `actorId` (1 to 128 characters) |
| Denial of service | Verifying a very large day is slow. | Verification is linear; the Merkle recursion is logarithmic in depth. Benchmark in week 8 per `docs/PLAN.md`. | not yet measured |
| Elevation of privilege | Replaying an old anchor to hide new rows. | The anchor is bound to a tenant, date, count and head hash. Detecting a stale anchor needs the next day's anchor to chain from it, which the nightly job must enforce. | open item for the nightly job |
| Key compromise | The HMAC key leaks. | Key held in KMS or Vault, never logged, versioned by `hmacSchemaVersion` for rotation. The anchor limits the damage to the time since the last anchor. | open item for the KMS adapter |

## Residual risks

- Rows deleted from the tail since the last anchor are undetectable until the next anchor is written. The window is at most one day.
- A Merkle inclusion proof binds a leaf to a root but not the tree size; the anchor's `count` pins the size.
- Erasure versus an immutable log is a legal question (see `docs/PLAN.md` section 5.2). The design deletes the identifier-to-pseudonym mapping and leaves the chain intact. A lawyer must confirm this.

Owner of residual risk: repository owner (`pranaav2k5`). Review again when the database and nightly job exist.

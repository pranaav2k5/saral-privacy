# ADR 0002: Canonical string v1 for audit entries and consent records

Status: accepted
Date: 2026-11-06

## Context

The audit log is a hash chain: each entry's hash covers the previous hash and a canonical string of the entry (docs/PLAN.md section 5.2). The canonical string is a contract between the API that writes entries, the verifier that recomputes them years later, and any outside auditor. If it changes silently, old entries stop verifying. The plan freezes it in week 2.

Two properties matter more than compactness: two different records must never give the same string, and every runtime must produce identical bytes.

## Decision

A canonical string is `JSON.stringify` of a fixed-order array of validated values, with a leading type tag and the version number. JSON escapes quotes, backslashes, control characters and newlines, so a field can never be confused with its neighbour. Field order is part of the contract.

- Audit entry v1: `["saral.audit", 1, tenantId, seqNo, ts, actorType, actorId, action, refTable, refId, payloadSha256]`
- Consent record v1: `["saral.consent", 1, tenantId, consentId, principalId, noticeId, noticeSha256, purposes, status, grantedAt, withdrawnAt, collectionMethod]`, where `purposes` is `[key, granted, retentionDays]` triples sorted by key in code-unit order.

Validation is strict and happens before serialisation: lowercase UUIDs, `seqNo` as a decimal string (the column is a bigint and JavaScript numbers lose precision above 2^53), timestamps as UTC with milliseconds that round-trip through `Date`, hashes as 64 lowercase hex characters, and closed sets for actor type, status and collection method. Anything else throws `CanonicalError` naming the field.

Addition to the plan's column list: audit entries carry `payloadSha256`, the SHA-256 of the canonical string of the record they refer to (for a consent, `canonicalConsentRecord`). Without it the chain proves that an entry was not edited but not that the consent row it points at is unchanged. v1 has no stored data yet, so adding the field now costs one column.

Frozen means: the golden vectors in `packages/schemas/src/canonical.test.ts` pin the exact output, and a test pins `SUPPORTED_CANONICAL_VERSIONS` to `[1]`.

## Consequences

- Changing any output of v1 is forbidden. To change the format, add version 2 beside v1, keep v1 readable, store `canonical_schema_version` per entry (the plan already does), and add golden vectors for v2.
- The format is verbose compared with a delimiter-joined string. Entries are small, so this is accepted.
- `seqNo` is a string everywhere it crosses a boundary.
- Revisit only if a verifier in another language cannot reproduce JSON string escaping byte for byte. The test vectors are the specification for that implementer.

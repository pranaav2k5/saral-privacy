# Compliance traceability matrix

Maps each DPDP requirement to the feature that implements it and the tests that prove it. Rule numbers are as cited in the Feasibility Study and in `docs/PLAN.md` section 7. They must be verified against the Gazette text by the legal advisor before general availability. Update this file in the same pull request that changes a feature or a test.

| Rule (as cited) | Requirement | Feature | Test IDs | Status |
|---|---|---|---|---|
| Rule 3 | Standalone notice, itemized data and purposes, withdrawal link, English or Eighth Schedule language | Notice generator, vertical templates | `packages/notice/src/*.test.ts` (43 tests), `apps/site/src/app/notice-generator/notice-form.test.tsx` (13 tests), review record `docs/compliance/notice-template-review.md` | engine and free page built; English and Hindi templates are drafts, legal review pending; in-product versioned notices not built |
| First Schedule Part B Item 4(c) | 7-year retention (a Consent Manager rule that we adopt for audit anchors as a conservative choice) | S3 Object Lock, 7 years | TC-RET-001 | not started |
| Rule 6(1)(e) and 8(3) | One-year minimum log retention | Audit log, lifecycle of at least 365 days | TC-RET-002 | in progress: canonical string v1 frozen (ADR 0002); hash chain, Merkle tree and anchors built and tested in `packages/audit-chain` (threat model 0001); database, nightly job and S3 retention not built |
| Rule 7 | 72-hour breach notification to the Data Protection Board | Breach workflow and timer | TC-BR-001 to 003 | not started |
| Rule 10 | Verifiable parental consent for children | Age gate in the SDK from MVP, DigiLocker later | TC-CHD-001 | not started |
| Rule 14 | Data-principal rights interface and contact | DSR endpoints and wallet | TC-DSR-001 to 010 | not started |
| Kantara KI-CR-v1.1.0 (our chosen receipt format, not a DPDP rule) | Signed, verifiable consent receipt | Receipts library, JWKS (`packages/receipts`, threat model 0002) | `packages/receipts/src/*.test.ts` (69 tests) | library built and tested; API route, KMS signer and public verifier not built |
| Rule 6 (reasonable security safeguards, as cited) | Tenant isolation, immutable audit table | Row-level security and audit table protections (`apps/api/db/migrations`, threat model 0003, ADR 0003) | `apps/api/test/db/*.test.ts` (55 tests, against PostgreSQL 16) | schema built and tested; the API's per-request tenant handling is not built |

# Compliance traceability matrix

Maps each DPDP requirement to the feature that implements it and the tests that prove it. Rule numbers are as cited in the Feasibility Study and in `docs/PLAN.md` section 7. They must be verified against the Gazette text by the legal advisor before general availability. Update this file in the same pull request that changes a feature or a test.

| Rule (as cited) | Requirement | Feature | Test IDs | Status |
|---|---|---|---|---|
| Rule 3 | Standalone notice, itemized data and purposes, withdrawal link, English or Eighth Schedule language | Notice generator, vertical templates | TC-NOT-001 to 030 | not started |
| First Schedule Part B Item 4(c) | 7-year retention (a Consent Manager rule that we adopt for audit anchors as a conservative choice) | S3 Object Lock, 7 years | TC-RET-001 | not started |
| Rule 6(1)(e) and 8(3) | One-year minimum log retention | Audit log, lifecycle of at least 365 days | TC-RET-002 | in progress: canonical string v1 frozen (`packages/schemas/src/canonical.test.ts`, ADR 0002); chain and retention not built |
| Rule 7 | 72-hour breach notification to the Data Protection Board | Breach workflow and timer | TC-BR-001 to 003 | not started |
| Rule 10 | Verifiable parental consent for children | Age gate in the SDK from MVP, DigiLocker later | TC-CHD-001 | not started |
| Rule 14 | Data-principal rights interface and contact | DSR endpoints and wallet | TC-DSR-001 to 010 | not started |

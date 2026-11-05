# @saral/verifier

Open-source audit verifier. It will recompute the per-tenant HMAC hash chain and the daily Merkle root from audit-log rows and compare the root with the copy anchored in S3 with Object Lock, so that auditors and data principals can check the log without trusting us.

Status: not built yet. The package is created in the audit-log plan (calendar weeks 7 to 8 in `docs/PLAN.md`). It is deliberately not a workspace package yet, so it has no `package.json`.

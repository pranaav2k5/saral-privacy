# @saral/verifier

Open-source audit verifier. It will recompute the per-tenant HMAC hash chain and the daily Merkle root from audit-log rows and compare the root with the copy anchored in S3 with Object Lock, so that auditors and data principals can check the log without trusting us.

Status: the verification logic is built and tested in `@saral/audit-chain` (`verifyChain`, `verifyAgainstAnchor`, `merkleProof`, `verifyMerkleProof`). This package will wrap it as a standalone command-line tool and read anchors from S3. It is deliberately not a workspace package yet, so it has no `package.json`.

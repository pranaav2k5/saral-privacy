# Security policy

Do not open public issues for security problems. Report them privately to the repository owner (`pranaav2k5`) through GitHub private vulnerability reporting (enabled on this repository: Security tab, "Report a vulnerability") or by direct message, with steps to reproduce and the affected component.

Secrets, keys, and personal data must never be committed. GitHub secret scanning and push protection are enabled on this repository, and CI runs gitleaks on every pull request. If you find a secret in the repository or its history, report it the same way so it can be rotated and removed.

This repository is public and under active development. It has no production deployment yet.

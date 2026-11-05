# Threat models

One STRIDE threat model per epic of 5 story points or more, checked in here as `NNNN-<epic>.md`. A pull request for such an epic is not done until its threat model exists (see the Definition of Done in `CONTRIBUTING.md`).

## Template

For each model, record:

- **Scope:** what is in and out, and the data flows involved.
- **Assets:** what an attacker would want (consent records, audit log, signing keys, tenant data).
- **Trust boundaries:** browser to API, API to database, tenant to tenant, us to cloud provider.
- **Threats** by STRIDE category (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege), each with a mitigation and a test or control that proves it.
- **Residual risk** and who accepted it.

First models due: the consent capture and receipt flow (calendar weeks 5 to 6) and the audit log (weeks 7 to 8). The tenancy boundary (row-level security) is the pen-test focus.

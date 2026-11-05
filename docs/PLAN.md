# Saral Privacy: Master Plan

Status: Draft v0.1, written 2026-11-05. Approved by the owner on 2026-11-05. The repository scaffold is built (see section 14 and ADR-0001).
Owner: pranaav2k5.

This plan merges two input documents and re-bases them on today's date:

- **Strategy report**: "Saral Privacy: A DPDP-Native Consent & Privacy Platform for India" (PDF, May 2026, 36 pages). Referred to below as **the Strategy Report**.
- **Feasibility study**: "Saral Privacy + Consumer Data Layer: Technical Feasibility & SDLC Plan" (Markdown, May 2026). Referred to below as **the Feasibility Study**.

Where the two disagree, section 3 records which one wins and why. Facts that were re-checked against outside sources are logged in `RESEARCH.md`. Anything marked **(my call)** is a judgment I made to reconcile or fill a gap. The owner has not agreed to those yet.

---

## 1. Where we stand: the clock

Both source documents were written in May 2026. They assume roughly six more months of runway than exists today.

| Date | Event | Status as of 2026-11-05 |
|---|---|---|
| 13 Nov 2025 | DPDP Rules 2025 notified | Done |
| **13 Nov 2026** | Consent Manager registration opens with the Data Protection Board (DPB) | **8 days away.** We do not plan to register (decision D2). |
| **13 May 2027** | Full compliance deadline: notices, consent, breach reporting, retention, data-principal rights. Penalties apply from here | **27 weeks away** |
| Unknown | DPB technical interoperability standard for Consent Managers | Not found published. Treat as pending. |
| Unknown | MeitY proposal to cut the 18-month window to 12 months | Proposed in Jan 2026, mostly aimed at Significant Data Fiduciaries. No notification found as of Oct 2026. Re-check the Gazette monthly. |

What this means for the plan:

1. The 16-week MVP in both documents would end around 28 Feb 2027 if work starts Monday 9 Nov 2026. That leaves about 11 weeks of selling time before the deadline. It is workable, but only if we start selling before the product is finished.
2. This is why the plan runs two tracks (decision D7). A free Privacy Notice Generator ships in week 4. The platform core ships in parallel.
3. A scope cut line is defined in section 4. If the schedule slips, features are cut in a fixed order and the deadline does not move.

Assumption: Week 1 starts Monday 9 Nov 2026. If the real start is later, every date below shifts by the same amount and the cut line matters more.

---

## 2. Thesis, goals, non-goals

### Thesis

Indian businesses that process digital personal data must comply with the DPDP Act by 13 May 2027, with penalties up to ₹250 crore for security failures. The incumbents are too expensive for small and mid-sized companies (OneTrust) or aimed at banks and large enterprises (Privy by IDfy, Perfios). Redacto raised a ₹12 crore seed in Oct 2025 and is the nearest direct competitor. The gap is a DPDP-native, Indic-language, SMB-priced consent and privacy operations platform with a tamper-evident audit trail.

### Goals

1. Ship a product an SMB Data Fiduciary can use to become audit-ready for DPDP in about 90 days: notice, consent capture with signed receipts, data-principal rights (DSR) handling, records of processing (RoPA), breach workflow, and an audit log the DPO can show the DPB.
2. Reach 3 paid pilots by 28 Feb 2027 and 10 paying customers by 13 May 2027.
3. Build trust through verifiability: a public JWKS endpoint, a public audit verifier, signed receipts, and a free consumer "DPDP Wallet".
4. Keep every architectural choice reversible until the DPB publishes its interoperability standard.

### Non-goals

- No blockchain, no token, no "monetize your data" feature. Both documents reject it, and the Consent Manager rules make it unworkable.
- No Consent Manager registration in the next 12 months (decision D2).
- No direct sales to banks, insurers, or hospitals at MVP. Their procurement needs ISO 27001 or SOC 2 reports we will not have.
- No DPI integrations (DigiLocker, eSign, Account Aggregator, ABDM, Aadhaar) until at least 3 paying customers ask for one.
- No NyāyaAI legal-AI product. The Strategy Report describes it as a later vertical on shared rails. It is out of scope here.

### Anti-goals (things that would make this a failure even if it ships)

- Claiming legal compliance. We provide tooling and templates. The customer's DPO and counsel remain responsible, and our marketing and terms of service must say so.
- Machine-translated notices published without human review.
- An audit log that cannot be explained to an auditor or that conflicts with erasure rights.
- A product that only works for English-speaking, tech-savvy customers.

---

## 3. Reconciled decisions

"Source" shows where the decision came from. "Mine" means I made the call to resolve a conflict or gap, and the owner should confirm it.

| ID | Decision | Source | Reason |
|---|---|---|---|
| D1 | Build the B2B DPDP SaaS first. The consumer layer is a free "DPDP Wallet" for trust, not a business. | Both | Both documents reject the data-wallet business. B2B demand is statutory. |
| D2 | **Do not register as a Consent Manager now.** Revisit at month 12 against the gate below. | Feasibility Study (overrides Strategy Report's "apply Q4 2026") | Needs ₹2 crore net worth, Indian incorporation, DPB approval, and conflict-of-interest separation from Data Fiduciaries. Our B2B revenue from Data Fiduciaries is itself a conflict if we register. The DPB interoperability spec is not out. |
| D3 | Beachhead: non-BFSI SMBs with 50 to 500 employees (edtech, healthtech, D2C, SaaS, HR-tech). | Both | BFSI is Privy and Perfios territory and needs certifications we lack. |
| D4 | Stack: Next.js (current supported major; 14 is end of life, see ADR-0001) + TypeScript for UIs; NestJS for the control plane; FastAPI only for the ML service; PostgreSQL 16 with row-level security; AWS ap-south-1; ECS Fargate; Terraform; no Kubernetes. | Feasibility Study | Avoids the three-backend sprawl in the Strategy Report. |
| D5 | Marketing site and free notice tool may run on Vercel or Cloudflare, because they hold no personal data. Anything that holds personal data runs in AWS ap-south-1. | Strategy Report, narrowed (my call) | Keeps the data-residency story clean for customers. |
| D6 | Mobile SDK is not in the MVP. Build it after GA. Choose React Native or Kotlin Multiplatform based on the first design partners' app stacks. | Mine | The two documents disagree (React Native vs KMM). A mobile SDK is a large cost for a small team. Most pilots start on web. |
| D7 | Two-track delivery. Track A is the free Notice Generator (English and Hindi) live in week 4 and put in front of 100 founders by week 6. Track B is the platform core. | Mine (merges both) | Strategy Report says the free tool is the most important MVP item. Feasibility Study sequences the audit spine first. We need both because the deadline is fixed. |
| D8 | Launch pricing hypothesis: Starter ₹15,000/month, Pro ₹50,000 to ₹2 lakh/month, Enterprise ₹15 to 60 lakh/year. Test ₹25,000 for Starter in discovery interviews. | Strategy Report (Feasibility Study had ₹25k / ₹1L / ₹3L) | Our ICP has a compliance budget under ₹5 lakh a year. Pricing is a hypothesis until interviews say otherwise. |
| D9 | Languages: English and Hindi at week 4. Add Tamil, Telugu, Bengali, Marathi by week 10. Add the rest after GA. Every language needs a human-reviewed template before it is marked "published". Machine-only output carries a "Beta, pending human review" mark. | Feasibility Study + mine | The Act requires notice in English or any one Eighth Schedule language, not all 22. |
| D10 | Translate **vertical templates** once, offline, with human review, and fill in tenant details at request time. Do not run a 1.1B-parameter model on the request path. | Mine | Cuts GPU cost, latency, and legal risk. Feasibility Study already says "async, cached". |
| D11 | Audit integrity: per-tenant HMAC hash chain in Postgres, nightly Merkle root written to S3 with Object Lock. Use Governance mode in dev and staging, Compliance mode in production only. | Feasibility Study + mine | Compliance mode cannot be shortened or deleted by anyone. Test data locked for 7 years is a cost with no benefit. |
| D12 | Pseudonymous principal IDs use a keyed HMAC (key held in KMS or Vault), not a salted SHA-256. | Mine | Phone numbers have a tiny search space. Anyone holding the salt can reverse a plain salted hash by brute force. |
| D13 | Defer DPI integrations. Keep the DEPA-aligned consent artefact JSON schema as a cheap forward-compatibility step. | Feasibility Study | 4 to 24 weeks each, with licences and agreements we cannot get quickly. |
| D14 | Vault API (PII tokenisation, "Layer 2") is post-GA. | Mine (Strategy Report put it at week 15) | The Strategy Report itself says to narrow the MVP to Notice, Consent SDK, and DSR. Week 15 is our pilot hardening week. |
| D15 | Certifications: external VAPT before GA is mandatory. ISO 27001 preparation starts after GA. SOC 2 only when revenue pays for it. Never promise certification dates to customers. | Feasibility Study, relaxed | Cost and effort are large for a student team. |
| D16 | Retain a privacy lawyer as advisor of record by week 2. Rule-by-rule legal review of notice templates and the traceability matrix is a GA gate. | Both | Founder credibility and legal accuracy are real risks. |
| D17 | Revenue targets in the Strategy Report are directional. Use the conservative set: 30 SMB + 5 mid-market in year 1 (about ₹1.3 crore ARR). Treat "100 customers in year 1" as a stretch. | Mine | The Strategy Report's own tables disagree (see `RESEARCH.md`). |

### Consent Manager gate (D2)

Reconsider registration only if all of these are true:

1. The DPB has published its Consent Manager interoperability standard.
2. At least 30% of customers ask for Consent-Manager-routed flows.
3. We can show ₹2 crore net worth (about ₹3 to 4 crore raised).
4. A lawyer has given a written opinion on the conflict-of-interest rules, and the plan is a separate subsidiary with an independent board.

If not, stay a SaaS vendor to Data Fiduciaries and partner with one of the registered or shortlisted Consent Managers.

---

## 4. Product scope

### P0: required for the first pilot (end of week 10)

1. **Privacy Notice Generator.** Free public version in English and Hindi (week 4). In-product version with tenant-specific data, versioning, SHA-256 canonical hash, and public notice URL.
2. **Consent capture.** Web JS SDK (UMD, 25 kB gzipped or less) with granular per-purpose toggles, defaults off for non-essential purposes, and a withdrawal path as easy as giving consent.
3. **Signed consent receipts.** Kantara KI-CR-v1.1.0 JSON as an RS256 JWT, signed with a KMS-managed key. Public JWKS at `/.well-known/jwks.json`. Conform to the ISO/IEC TS 27560 minimal record where possible.
4. **Tamper-evident audit log.** HMAC chain, nightly Merkle anchor, `/v1/audit/verify`.
5. **Data-principal rights (DSR).** Access, correction, erasure, nomination, grievance. State machine, SLA timers, DPO review screen.
6. **Webhooks.** HMAC-SHA256 signed, idempotency key, exponential-backoff retries.
7. **Multi-tenancy and auth.** Row-level security, scopes for `tenant_admin`, `dpo`, `sdk`, `principal`, `auditor`, MFA for admin and DPO.

### P1: required for GA (end of week 16)

8. **RoPA wizard.** About 30 guided questions, versioned JSON and PDF export.
9. **Breach workflow.** Incident form, 72-hour DPB notification template, plain-language notice to affected principals, DPO sign-off step, every step logged.
10. **DPO dashboard.** Consent funnel, DSR queue, audit health.
11. **Four more languages** (Tamil, Telugu, Bengali, Marathi) with human-reviewed templates.
12. **External VAPT** by a CERT-In empanelled auditor, with findings fixed.
13. **Public verifier page and JWKS** as the trust differentiator.

### P2: after GA

Consumer DPDP Wallet (a beta is planned for week 12 but it is the first thing cut), cookie CMP module, vendor-risk module, mobile SDK, PII detection with regex and checksums and then IndicNER, children's data with DigiLocker, eSign, Vault API, SSO for Enterprise, silo-DB option for large tenants, Account Aggregator and ABDM via partners.

### Cut line

If the schedule slips, cut in this order and stop as soon as the schedule is safe:

1. Consumer wallet beta
2. Languages beyond English, Hindi, and two more
3. RoPA PDF export (keep JSON)
4. DPO dashboard polish
5. Breach workflow polish (keep the 72-hour template and timer)

**Never cut:** the free notice tool, consent receipts, the audit log and verifier, DSR, row-level security, and the external VAPT.

---

## 5. Architecture

### 5.1 System shape

```
Users
  -> Cloudflare (WAF, CDN)
  -> Next.js B2B dashboard | Next.js consumer wallet (PWA) | marketing + free notice tool
  -> NestJS API (ECS Fargate, ap-south-1, JWT scopes)
       -> PostgreSQL 16 (RDS, row-level security)
       -> Job queue -> nightly Merkle job -> S3 (Object Lock)
       -> FastAPI ML service (translation templates, PII regex + NER; async only)
  Secrets and keys: AWS KMS (tenant KEKs, receipt-signing key), Vault or KMS for HMAC chain key
  Observability: OpenTelemetry -> Grafana
```

Region: ap-south-1 (Mumbai) primary, ap-south-2 (Hyderabad) for disaster recovery later. No cross-border replication of personal data.

### 5.2 Key design points

**Multi-tenancy.** One shared database with a `tenant_id` column and a Postgres row-level security policy on every tenant-owned table. A silo-per-tenant option exists for customers above ₹50 lakh ARR. Pen-test focus: the tenancy boundary.

**Consent record and receipt.** `POST /v1/consents` writes a consent record, builds the canonical string (version 1), appends an audit entry, mints the signed receipt, emits the webhook, and returns the JWT. The canonical string schema is a versioned contract. It is frozen in week 2. Changes bump `canonical_schema_version` and are never edited silently.

**Audit log.**
- Table `consent_audit_log`: `seq_no`, `tenant_id`, `ts`, actor, action, `ref_table`, `ref_id`, `canonical_schema_version`, `prev_hash`, `entry_hash`, `hmac_schema_version`.
- `entry_hash = HMAC(key, prev_hash || canonical)`. Appends are serialized per tenant with an advisory lock.
- `REVOKE UPDATE, DELETE` plus a trigger that raises on update or delete.
- A nightly job computes the Merkle root of the day's hashes and writes it to S3 with Object Lock.
- `/v1/audit/verify` recomputes the chain and the root. A verifier job also runs against staging every 5 minutes.
- Throughput risk: the per-tenant lock serializes appends. Benchmark in week 8. If the verifier takes longer than 5 minutes for one day, shard by `(tenant_id, day)`.

**S3 Object Lock.** The Feasibility Study says Object Lock cannot be added to an existing bucket. That is out of date: AWS now supports `PutObjectLockConfiguration` on existing buckets (versioning required, and it cannot be turned off afterward). Create buckets in Terraform with it on anyway, because it is simpler and safer.

**Erasure vs immutable log (needs legal review).** The log stores only pseudonymous principal IDs and event metadata, never raw personal data. Pseudonyms come from a keyed HMAC (D12). On an erasure request we delete the mapping from real identifiers to the pseudonym, so the log entries can no longer be linked to a person while the chain stays intact. A lawyer must confirm this satisfies erasure while meeting the retention rules.

**Identity bridge.** Tenant-scoped ID: `HMAC(key, phone_e164 || tenant_id)`. Cross-tenant wallet ID: `HMAC(key, phone_e164)`. Raw phone and email live only in an encrypted contact table. Wallet login uses phone OTP.

**Translation and notices.** Templates per industry vertical are written in English, then translated once with IndicTrans2 and reviewed by a human. Request-time notice generation fills slots in the reviewed template. Free-text additions from tenants are machine-translated asynchronously, marked "pending human review", and cached by `notice_id`. Benchmark IndicTrans2 against at least one alternative on our target languages in week 3, because I found no independent comparison with newer models.

**Security baseline (DPDP Rule 6).** TLS 1.3, HSTS, CSP, AES-256-GCM at rest, envelope encryption with per-tenant keys, MFA for admin and DPO, least-privilege IAM, every PII access logged with who, what, when, why, and consent ID, and a 72-hour breach template. No secrets in git or environment variables.

**Infrastructure cost warning.** The Strategy Report targets under ₹15,000 a month for the MVP. The Feasibility Study stack (multi-AZ RDS, ElastiCache, Fargate, Vault, Grafana, a GPU instance) will cost far more if everything is always on. I could not price it: the AWS Pricing API call failed for lack of valid credentials. Before week 3, build the AWS estimate in the AWS Pricing Calculator. Use single-AZ RDS and no GPU in dev, scale-to-zero or batch GPU for translation, and no ElastiCache until measured load needs it.

### 5.3 Key tables

`tenants`, `principals`, `tenant_principals`, `privacy_notices`, `consent_records`, `consent_audit_log`, `consent_receipts`, `dsr_requests`, `ropa_versions`, `breach_incidents`, `webhook_deliveries`. Full column lists are in the Feasibility Study section 3.5. Changes from that draft: replace the salted SHA-256 columns with keyed-HMAC values (D12), and add `breach_incidents` and `webhook_deliveries`.

### 5.4 API scopes

| Scope | Examples |
|---|---|
| `tenant_admin` | notices, consents query, RoPA, breaches |
| `sdk` | create consent, revoke, fetch receipt |
| `principal` | list own consents, revoke, submit DSR, export |
| `auditor` | `/v1/audit/verify`, `/v1/audit/merkle-root` |

Webhook signature header: `X-Saral-Signature: t=...,v1=...`, with idempotency key and up to 15 retries.

---

## 6. Delivery plan

### 6.1 Method

Scrum-lite with 2-week sprints and trunk-based development. Pull-request review is required. Feature flags with Unleash. Weekly demo to the faculty advisor and design partners.

**Definition of Done:** unit tests, integration test, threat-model checkbox, RoPA-impact check, and an audit event for every user-facing action.

**Roles (assuming 3 to 5 people):** tech lead who also acts as PM, backend and security engineer, frontend and SDK engineer, ML and DevOps engineer, and one business and GTM person. If there is no business person, that gap is the biggest risk to the revenue targets.

### 6.2 Calendar (Week 1 = Monday 9 Nov 2026)

| Week | Dates | Track A: free tool and market | Track B: platform |
|---|---|---|---|
| 1 | 9 Nov | Pick name and domain. 10 discovery interviews. Recruit lawyer advisor. | AWS accounts, Terraform bootstrap, buckets with Object Lock (Governance in non-prod). Read the Act, Rules, and MeitY BRD. |
| 2 | 16 Nov | 15 more interviews (25 total: 10 SMB founders, 5 mid-market DPOs, 5 lawyers, 5 CTOs). Shortlist 3 design partners. | Freeze canonical string v1 and receipt schema. HLD and LLD. Threat model. Traceability matrix v0. **Check DPB notices after 13 Nov.** |
| 3 | 23 Nov | Build free Notice Generator (English, Hindi). Marketing site. | CI, ECS, RDS, KMS. NestJS scaffold. IndicTrans2 benchmark. Infra cost estimate. |
| 4 | 30 Nov | **Free Notice Generator live (Fri 4 Dec).** Product Hunt India and LinkedIn launch. DPDP Readiness Score quiz. | Postgres schema, RLS policies, auth scopes, MFA. |
| 5 to 6 | 7 to 18 Dec | Reach 100 founders (by Fri 18 Dec). Outbound to 200 targets. | Consent JS SDK v0.1, receipt JWT, JWKS, webhooks. |
| 7 to 8 | 21 Dec to 1 Jan | Content: 2 explainer posts a week. Pilot outreach. | Audit log, Merkle anchoring, verify endpoint. Self pen-test of the audit module. Allow buffer for holidays. |
| 9 to 10 | 4 to 15 Jan | Onboard design partners. | DSR state machine, DPO UI, in-product notice generator, RoPA wizard. **Pilot gate: P0 complete (Fri 15 Jan).** |
| 11 | 18 Jan | Pilot support. | Breach workflow, DPO dashboard. |
| 12 | 25 Jan | Case-study drafts. | Consumer wallet beta (cut first if behind). Four extra languages reviewed. |
| 13 | 1 Feb | Convert first pilot to paid. | Security hardening. Book external VAPT early (week 6) so the slot exists. |
| 14 | 8 Feb | Pricing page. CA/CS channel conversations. | External VAPT, k6 load test, chaos test. |
| 15 | 15 Feb | Second and third paid pilots. | Fix findings. Docs. Status page. |
| 16 | 22 Feb | **GA launch (by Fri 26 Feb).** | Release, runbooks, on-call rota. |
| 17 to 27 | 1 Mar to 13 May | **Deadline campaign:** webinars with CA/CS firms, content, outbound, reach 10 paying customers. | Fix and iterate from customer feedback. Start ISO 27001 preparation. |

Book the external VAPT slot in week 6, not week 14. Empanelled auditors have waiting lists.

### 6.3 Milestones and exit criteria

| Milestone | Date | Exit criteria |
|---|---|---|
| M0 Discovery done | 20 Nov | 25 interviews summarized in one page. Lawyer advisor signed. 3 design partners shortlisted. Schemas frozen. |
| M1 Free tool live | 4 Dec | Public URL, English and Hindi, 12-page notice in under 5 minutes, analytics wired. |
| M2 Spine works | 18 Dec | A test consent produces a signed receipt that verifies with the public JWKS. |
| M3 Audit verified | 1 Jan | Verifier passes on a full day of synthetic load. Tamper test (edit one row) is detected. |
| M4 Pilot gate | 15 Jan | P0 complete. Two design partners can log in. |
| M5 GA | 26 Feb | P1 complete. VAPT critical and high findings fixed. 3 paid pilots. |
| M6 Deadline | 13 May | 10 paying customers. Zero open critical bugs. |

### 6.4 Testing

| Layer | Tooling | Cadence |
|---|---|---|
| Unit (80% or more on auth, consent, audit) | Jest, pytest | Every commit |
| Integration | Testcontainers, Supertest | Every PR |
| End-to-end | Playwright | Nightly |
| Load | k6: 1,000 consents per second sustained per tenant; verifier p95 under 200 ms for a 24-hour slice (targets from the Feasibility Study; confirm they are sensible in week 8) | Pre-release |
| Static security | Semgrep, gitleaks, Trivy, Checkov | Every commit |
| Dynamic security | OWASP ZAP baseline | Nightly |
| Audit chain integrity | Verifier against staging | Every 5 minutes |
| External | CERT-In empanelled VAPT | Before GA, then quarterly |

Contract tests (Pact) are optional until the SDK has external users.

### 6.5 Environments and release

`dev` (always on, small), `staging` (production-like, synthetic data), `prod` (Mumbai). Pipeline: lint, typecheck, unit, integration, container build, Trivy, push, Terraform plan, e2e, manual approval, apply, smoke test, tag. SLOs for the MVP: `/v1/consents` p95 under 250 ms, 99.5% availability.

---

## 7. Compliance traceability

The matrix below is carried over from the Feasibility Study. Rule numbers are as cited there and must be verified against the Gazette text by the legal advisor before GA. Test IDs are placeholders to fill in as tests are written.

| Rule (as cited) | Requirement | Feature | Test IDs |
|---|---|---|---|
| Rule 3 | Standalone notice, itemized data and purposes, withdrawal link, English or Eighth Schedule language | Notice generator, templates | TC-NOT-001 to 030 |
| First Schedule Part B Item 4(c) | 7-year retention (Consent Manager rule; we adopt it for audit anchors as a conservative choice) | S3 Object Lock, 7 years | TC-RET-001 |
| Rule 6(1)(e) and 8(3) | One-year minimum log retention | Audit log, lifecycle of at least 365 days | TC-RET-002 |
| Rule 7 | 72-hour breach notification to the DPB | Breach workflow and timer | TC-BR-001 to 003 |
| Rule 10 | Verifiable parental consent for children | Age gate in SDK from MVP, DigiLocker later | TC-CHD-001 |
| Rule 14 | Data-principal rights interface and contact | DSR endpoints, wallet | TC-DSR-001 to 010 |

---

## 8. Go-to-market

### 8.1 Customer profile

- **Beachhead:** SMBs with 50 to 500 employees in edtech, healthtech, D2C, fintech-lite, SaaS, and HR-tech. Founders aged 28 to 45, no DPO yet, compliance budget under ₹5 lakh a year, worried about 13 May 2027.
- **Expansion 1:** mid-market (500 to 5,000 employees) with a DPO or one being hired, budget ₹15 to 60 lakh a year.
- **Expansion 2 (later):** Significant Data Fiduciaries. Do not target until certifications exist.

### 8.2 Funnel

1. Free Privacy Notice Generator (the lead engine).
2. DPDP Readiness Score quiz (lead qualification).
3. 14-day trial with the consent SDK on a staging site.
4. 45-minute onboarding call that maps processing activities to a RoPA template.
5. Conversion to a paid plan, with a breach-workflow demo as the closing moment.

### 8.3 Channels

- LinkedIn content: 2 long-form DPDP explainers a week.
- Direct outbound: 200 edtech, D2C, and healthtech founders, with first lines based on their current privacy notice or its absence.
- Channel partners: CA and CS firms and mid-tier law firms already advising clients on DPDP, with revenue share.
- Ecosystem: Sahamati and DSCI mailing lists and working groups.
- Government: GeM listing and MeitY-empanelled startup status (later).

### 8.4 Pricing and unit economics (hypotheses from the Strategy Report)

| Tier | Price | Notes |
|---|---|---|
| Starter | ₹15,000/month (₹1.8 lakh/year), 10,000 MAUs | Notice, consent banner, DSR portal. Test ₹25,000. |
| Pro | ₹50,000 to ₹2 lakh/month | Adds RoPA, vendor risk, breach workflow, audit export, branding. |
| Enterprise | ₹15 to 60 lakh/year | Private VPC option, SSO, custom integrations. |
| Vault API | About ₹0.50 per record | Post-GA. |

The Strategy Report's year-3 illustration gives a Starter LTV of about ₹3.9 lakh against a CAC of ₹40,000, and a Pro LTV of about ₹19 lakh against a CAC of ₹1.2 lakh. I re-computed these and the arithmetic is consistent. The inputs (72% gross margin, 3-year retention, CAC) are untested guesses. Replace them with measured numbers by month 6.

### 8.5 Targets

| By | Target |
|---|---|
| 4 Dec 2026 | Free tool live |
| 18 Dec 2026 | 100 founders reached |
| 28 Feb 2027 | 3 paid pilots |
| 13 May 2027 | 10 paying customers (about ₹18 lakh ARR at Starter pricing) |
| Nov 2027 | 30 SMB + 5 mid-market, about ₹1.3 crore ARR |

---

## 9. Competition and defensibility

| Player | Position | Threat to us |
|---|---|---|
| Privy by IDfy | Won MeitY and NeGD "Code for Consent" challenge (reported July 2026, Jio Platforms runner-up). Reports 50+ deployments. Enterprise and BFSI. | High in enterprise, low in SMB. |
| Redacto | ₹12 crore seed (PeerCapital, Antler India, Oct 2025). Founded 2025. Payments, NBFCs. | The most direct competitor. |
| Perfios DPDP suite | BFSI focus | Low in SMB |
| OneTrust | Global leader, priced for large enterprises | Low in SMB |
| Tsaaro and law-firm tooling | Services-heavy | Channel partners, not rivals |
| TCS, Jio and other large players | Slow, expensive | Low in SMB |

Defensibility, in order of how much I trust it:

1. **Indic-language UX with human-reviewed templates.** Hard for global players to copy and costly for us to maintain.
2. **Trust artefacts:** public verifier, JWKS, signed receipts.
3. **Price and self-serve onboarding** for SMBs.
4. **Switching cost** once a customer's consent history lives with us.
5. **A future Consent Manager licence** (not planned now).

The Strategy Report's claim that the SMB segment is "essentially untouched" is plausible but unverified. Test it in the 25 discovery interviews.

---

## 10. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Calendar compression: 27 weeks to the deadline | Certain | High | Two tracks, cut line, early selling. |
| R2 | Enforcement delayed or softened, so SMBs defer buying | Medium | High | Sell on due diligence and investor questions as well as fines. Keep burn low. |
| R3 | MeitY shortens the window for some obligations | Low to medium | Medium | Monthly Gazette check. The free tool and the audit core come first. |
| R4 | Redacto or Privy moves down-market | Medium | High | Win on Indic UX, price, and speed. Track both monthly. |
| R5 | Audit-log throughput bottleneck from per-tenant locks | Medium | High | Benchmark week 8. Shard by tenant and day if needed. |
| R6 | RLS bypass through a misconfigured role | Medium | High | Static checks on migrations, `pgaudit`, pen-test the tenant boundary, one paid DBA review in sprint 2. |
| R7 | HMAC key compromise leads to a silent chain rewrite | Low | Critical | Key in KMS or Vault, never logged. Daily anchor in Object Lock closes the gap. |
| R8 | Erasure conflicts with the immutable log | Medium | High | Pseudonym mapping deletion design (section 5.2). Lawyer sign-off. |
| R9 | Poor translation quality in low-resource languages | High | Medium | Template-first, human review gate, watermark for machine-only output. |
| R10 | Legal inaccuracy in templates exposes customers or us | Medium | High | Lawyer advisor, terms that disclaim legal advice, template review gate. |
| R11 | Infrastructure cost exceeds the budget | High | Medium | Cost estimate in week 3, small dev footprint, no GPU always-on. |
| R12 | Team bandwidth, exams, or no sales person | Medium | High | Confirm academic calendar and roles now (open decision O1). |
| R13 | DPB interoperability spec arrives and breaks assumptions | Certain eventually | Medium | Build to Kantara and ISO 27560, keep schemas versioned, plan a 4-week retrofit sprint. |
| R14 | A breach at a customer or at us | Low | Critical | Encryption by default, least privilege, incident runbook, status page, terms of service limits. |
| R15 | Customers misread our tool as a compliance guarantee | Medium | High | Clear wording in product, contract, and marketing. |

### Thresholds that change the plan

- DPB publishes the Consent Manager standard: schedule a 4-week retrofit sprint and re-open the D2 gate review.
- Any single customer above ₹50 lakh ARR: offer the silo-database option.
- Audit verifier takes over 5 minutes for a one-day slice: shard the audit log.
- A DPB action against us or a customer: freeze feature work and run incident response.
- Gazette notifies a shortened window: pull P1 scope forward and reduce languages.

---

## 11. After GA: roadmap

| Window | Focus |
|---|---|
| Months 4 to 6 (Mar to May 2027) | Deadline campaign. Vendor-risk module. Cookie CMP module. First 10 paying customers. ISO 27001 preparation. |
| Months 7 to 9 | Mobile SDK, driven by customer stacks. First ISO 27001 audit. Decide pre-seed: raise ₹3 to 5 crore if 5 or more customers pay and growth is strong (Strategy Report suggests a month-6 decision point). |
| Months 10 to 12 | DigiLocker for children's data and eSign, only if 3 or more customers ask. Vault API beta. SOC 2 Type I if revenue supports it. **Consent Manager gate review (D2).** |
| Months 13 to 18 | Sahamati TSP listing for the fintech vertical. DEPA artefact exports. Enterprise tier. Possibly a separate Consent Manager subsidiary if the gate is met. |

Funding path (Strategy Report): pre-seed ₹1 to 3 crore from investors such as Antler India, 100X.VC, Better Capital, Blume, and Together Fund. Apply to Antler, 100X.VC, NASSCOM DeepTech Club, Microsoft for Startups, AWS Activate, and Y Combinator. AWS Activate credits matter because of the infrastructure cost warning. Investor lists in the Strategy Report are suggestions, not confirmed interest.

---

## 12. Next seven days

1. Confirm the open decisions in section 13.
2. Reserve the name and domain (the two source documents use both `saralprivacy.com` and `saralprivacy.in`; pick one).
3. Read the DPDP Act, Rules, and MeitY business requirements document. About 10 hours. Take notes by rule number.
4. Sign up to OneTrust, Privy, Redacto, Perfios, and Tsaaro trials. Screenshot everything.
5. Send 30 outreach messages to SMB founders for 20-minute interviews.
6. Find a privacy lawyer advisor (boutique firms, young associates, equity or paid hourly).
7. Create the AWS organization and apply for AWS Activate.
8. Hold a team session to argue with this plan. Write a one-page founders' agreement covering roles, equity, and vesting.
9. Check DPB and MeitY notices after 13 Nov for the Consent Manager process and any timeline amendment.

---

## 13. Open decisions for the owner

- **O1. Team and calendar.** How many people, in what roles, and when does the team actually start? When are final-year exams or project deadlines?
- **O2. Funding and runway.** Is there money for external VAPT, a lawyer, and AWS bills, or do we depend on AWS Activate credits?
- **O3. Design partners.** Are any SMBs already willing to pilot?
- **O4. Name and domain.** Confirm "Saral Privacy" and the domain.
- **O5. Confirm my calls.** D5, D6, D7, D9, D10, D11, D12, D14, D17 are my judgments and need a yes or no.

---

## 14. Proposed repository layout

The scaffold below is built (branch `chore/scaffold`). `packages/verifier/` is a README only until the audit-log plan. Deviations from the original draft are recorded in `docs/adr/0001-toolchain-and-versions.md`.

```
saral-privacy/
  README.md
  docs/
    PLAN.md            this file
    RESEARCH.md        verification log and source discrepancies
    adr/               one short file per architecture decision
    threat-model/      STRIDE per epic
    compliance/        traceability matrix, template review records
  apps/
    web/               B2B dashboard (Next.js)
    wallet/            consumer wallet PWA (Next.js)
    site/              marketing site and free notice tool
    api/               NestJS control plane
    ml/                FastAPI service
  packages/
    sdk-js/            consent SDK (UMD, 25 kB gzipped budget)
    schemas/           canonical string and receipt schemas (versioned)
    verifier/          open-source audit verifier
  infra/
    terraform/         AWS modules (buckets with Object Lock, KMS, RDS, ECS)
  .github/workflows/   CI
```

Branching: trunk-based on `main`, short-lived feature branches, pull-request review required, secret scanning and dependency scanning on from the first commit.

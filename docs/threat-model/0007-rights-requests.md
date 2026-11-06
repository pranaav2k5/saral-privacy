# Threat model 0007: data-principal rights requests (DSR)

Status: draft, covers `apps/api/src/dsr`, `src/crypto/contact-crypto.ts` and migration 0006. Contract: `/v1/dsr` in `docs/design/openapi.yaml`.

## Scope

A person submits a request (access, correction, erasure, nomination, grievance); the tenant's data protection officer (DPO) works it through a state machine; an erasure request, when fulfilled, erases. Out of scope: how the DPO proves a person's identity (a manual step in state `identity_pending`), how the answer reaches the person (the DPO uses the revealed contact), and staff login (the `dpo` scope is a secret API key until staff login exists).

## Assets

The person's contact details; their free-text request; the integrity of the audit trail of who did what to a request; the correctness of an erasure.

## Threats

| STRIDE | Threat | Mitigation | Proof |
|---|---|---|---|
| Information disclosure | The raw phone number or email address is stored or leaked. | It is kept only in `principal_contacts`, sealed with AES-256-GCM, bound to the tenant and person (a sealed value moved to another row does not decrypt), with a fresh nonce each time. A test searches every table for the plain value. It is never in audit entries, webhooks or the free text limit. | `contact-crypto.test.ts` (with a blob sealed by Python's AES-GCM), `dsr.e2e.test.ts` |
| Information disclosure | Anyone who knows an identifier learns whether the person is a customer. | Submitting returns the same shape whether or not the person was known. | `dsr.e2e.test.ts`: same answer |
| Information disclosure | A DPO key reads contacts without a trace. | `reveal-contact` writes a `dsr.contact_revealed` audit entry naming the key; only the `dpo` scope may call it. | `dsr.e2e.test.ts`: the person's contact |
| Information disclosure | Another tenant's requests are read. | Row-level security on `dsr_requests` and `principal_contacts`; composite foreign keys; cross-tenant ids answer 404. | `dsr.test.ts` (database), `dsr.e2e.test.ts` |
| Tampering | A request is moved to an impossible state, skips identity checks, or is changed after the fact. | A database trigger allows only the legal moves (all 36 pairs are compared with the TypeScript state machine), forces a reason for a rejection, and lets only `state`, `decided_reason` and `closed_at` change, for the owner too. The service takes a row lock and answers 409 with the allowed moves. | `state.test.ts`, `dsr.test.ts`, `dsr.e2e.test.ts` |
| Tampering | A half-done erasure (contact deleted but consents left, or the reverse). | One transaction: the move, the erasure, its audit entry and its webhook. A forced failure at the last step leaves nothing changed. | `dsr.e2e.test.ts`: part way |
| Repudiation | A DPO denies moving or rejecting a request. | Every submission and move is an audit entry with the actor and a hash of the request's state and reason. | `dsr.e2e.test.ts` |
| Elevation of privilege | A person (publishable key) reads or moves requests. | `sdk` may submit only; every other route needs `dpo`. | `dsr.e2e.test.ts`: scopes |
| Denial of service | A stranger floods a tenant's queue with requests for other people's identifiers. | **Not mitigated**: no rate limiting, and nothing proves the submitter controls the identifier. Mitigated in effect: a request does nothing until the DPO moves it, and an erasure request needs identity confirmation before it is fulfilled. | open item |
| Tampering | A stranger submits an erasure request for someone else and the DPO fulfils it without checking. | The state machine has an explicit `identity_pending` step, but it is optional (a DPO may go straight to `in_review`). Operational rule: the DPO must confirm identity before fulfilling an erasure. | open item |

## Erasure design and its limits

Fulfilling an erasure withdraws the person's consents, deletes the sealed contact, and replaces their pseudonym with a random value, so their identifier no longer leads to them. The audit chain keeps its entries, which hold only ids and hashes, so it still verifies. **Whether this satisfies the Act's erasure right alongside the retention rules is unconfirmed and needs the lawyer advisor** (`docs/PLAN.md` section 5.2). Data held outside this system (the tenant's own databases) is not touched; the tenant is told through the `dsr.transitioned` webhook and must erase its own copies.

## Residual risks

- The 30-day due date is a working default, not confirmed against the Rules.
- `access` and `correction` requests are tracked and answered by the DPO by hand; the system does not compile the person's data.
- Request details are free text and may contain personal data; they are limited to 2000 characters and shown only to the `dpo` scope.
- The `dpo` scope is a secret API key until staff login with MFA exists.

Owner of residual risk: repository owner (`pranaav2k5`).

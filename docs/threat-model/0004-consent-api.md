# Threat model 0004: consent API (grant, withdraw, receipt, audit verification)

Status: draft, covers `apps/api` as built in the consent API task. Webhooks, data-principal rights, staff login and the dashboard extend it. Contract: `docs/design/openapi.yaml`.

## Scope

In scope: API key authentication and scopes, the consent grant and withdrawal flows, receipt issuance, the public JWKS and notice endpoints, and audit verification. Out of scope: KMS key handling (a dev provider exists; production has a placeholder that answers 503), rate limiting (not built), and TLS termination.

## Assets

Consent records and receipts; the audit chain; API key secrets; the pseudonym and audit HMAC keys; the receipt signing key; the phone numbers and emails that pass through requests.

## Trust boundaries

Browser or server client to API; API to PostgreSQL (as `saral_app`, threat model 0003); API to KMS (later); tenant to tenant.

## Threats

| STRIDE | Threat | Mitigation | Proof |
|---|---|---|---|
| Spoofing | Guessing or brute-forcing API keys. | Keys carry 256 bits of secret. Only a keyed HMAC of the secret is stored. Comparison is constant-time. Unknown id, wrong secret, revoked and malformed all return the same 401 body, so a caller learns nothing about which keys exist. | `auth.e2e.test.ts`: authentication |
| Spoofing | A stolen database copy is used as credentials. | The `api_keys` table holds only HMACs under a server pepper that is not in the database. | `api-keys.test.ts`, `auth.e2e.test.ts`: key from another deployment |
| Elevation of privilege | A route is added without an access rule. | Deny by default: a route with no `@Public()` or `@Scopes()` answers 403. A test compares every served route and its rule with `docs/design/openapi.yaml`. | `auth.e2e.test.ts`, `openapi.test.ts` |
| Elevation of privilege | A key is used for more than its scope (an `sdk` key reading the audit log, an auditor recording consents). | Scopes are checked per route; a publishable key can only have the `sdk` scope (database CHECK). | `auth.e2e.test.ts`: authorization |
| Information disclosure | One tenant reads or withdraws another's consent. | Every query runs under row-level security with the key's tenant. A cross-tenant id answers 404, the same as a missing one. | `consent.e2e.test.ts`, `rls.test.ts` |
| Information disclosure | The phone number or email is stored or leaked. | It is normalised, turned into a keyed HMAC with the tenant id, and discarded. A test searches every table for the raw value. Receipts carry only the pseudonymous principal id. The reverse proxy and any request logging must not record request bodies (deployment rule). | `consent.e2e.test.ts`: never stored |
| Tampering | A caller sets retention or receipt details. | Retention and receipt fields come from the notice's purpose definitions, which only operators write. | `consent.e2e.test.ts`: retention |
| Tampering | A consent is changed after the fact. | Consents only finish (database trigger); every change appends a chained audit entry whose payload hash covers the consent's content. | `integrity.test.ts`, `audit.e2e.test.ts` |
| Tampering | Concurrent requests fork or gap the audit chain. | A per-tenant advisory lock inside the transaction, a database trigger for the link, timestamps that never go backwards. | `audit.e2e.test.ts`: 100 concurrent consents |
| Repudiation | A person denies withdrawing, or a tenant denies a consent. | Signed receipt for the grant; chained audit entry for the grant and the withdrawal. | `consent.e2e.test.ts`, `audit.e2e.test.ts` |
| Spoofing | Someone withdraws another person's consent by knowing the consent id. | Withdrawal needs the person's identifier, checked in constant time. A wrong identifier looks like an unknown consent. | `consent.e2e.test.ts`: withdrawal |
| Spoofing | **Someone forges consents for other people's phone numbers**, because a publishable key is visible in a web page and the API cannot tell who typed the number. | Partly mitigated: origin restriction for publishable keys, a receipt and audit entry that record the collection method (`web_sdk`), and consents bound to the notice hash. Not mitigated: nothing proves the person controls the identifier. | `auth.e2e.test.ts`: origin; **open risk** |
| Denial of service | Request floods, or very large bodies. | The default body size limit applies. Requests are limited per address and per key (threat model 0011). | `ratelimit.e2e.test.ts` |
| Denial of service | One `verify` request loads a whole chain into memory, or a connection waits forever. | A request is limited to 100,000 entries (422 with advice to verify by day); the pool waits at most 5 seconds for a connection and no query runs over 30 seconds; the pool logs dropped idle connections instead of crashing. | `audit.e2e.test.ts`, `database.test.ts` |
| Repudiation | A person holding only a receipt cannot tell what it covers or find the consent id. | The receipt points to the immutable public notice and names the consent (`saralConsentId`), the notice id and the notice text's hash, so the holder can withdraw by consent id and identifier. | `consent.e2e.test.ts` |
| Tampering | A retry after a lost response records the same consent twice, leaving an orphan that can never be withdrawn. | A random client-held `Idempotency-Key` returns the first result for the same request (200), under a per-tenant lock so simultaneous retries cannot both record; the same key with a different request, or for a consent no longer granted, is 409. Matching by identifier was tried and removed: it handed a stored receipt to anyone who knew the identifier and showed whether a person was a customer. | `consent.e2e.test.ts`: retrying a consent request safely |
| Elevation of privilege | Anyone with a publishable key (public in a web page) withdraws a person's consents knowing only their email or phone number. | Withdrawal by identifier alone needs a secret key (403 for a publishable key); the browser path needs the consent id and the identifier. | `consent.e2e.test.ts`: withdrawing every consent of a person |
| Information disclosure | A misconfigured production boots with development keys. | The dev key provider refuses `NODE_ENV=production`; production boots with a provider that answers 503 for anything needing a key. | `key-provider.test.ts`, image smoke test |
| Tampering | The audit log is edited behind the API's back. | `/v1/audit/verify` recomputes the chain and reports the failing `seqNo`. | `audit.e2e.test.ts` |

## Residual risks

- **Consent forgery through publishable keys.** Fixing it needs proof that the person controls the identifier (an OTP or a signed claim from the tenant's server). Until then, tenants who need high assurance should record consents from their server with a secret key after verifying the person, and receipts show `api` as the collection method. This must be in the pilot agreement and the documentation.
- No API key rotation or listing routes for tenants yet. Rate limits are in memory per instance (threat model 0011).
- Consents are never recognised by identifier: every request without an `Idempotency-Key` is a new consent, so a person who consents on two devices has two consents. `POST /v1/consents/withdraw` (secret keys only) withdraws all of a person's granted consents; the browser SDK withdraws the one it holds the id of.
- The audit verification endpoint reads a whole tenant chain or one UTC day into memory. Benchmark in week 8 as planned and shard if needed.
- Day boundaries for anchors are UTC days. The nightly job in the plan runs at 02:00 IST; the job and the day definition must be reconciled when the job is built.
- The pseudonym key and audit key live in a development provider. KMS adapters are not built.

Owner of residual risk: repository owner (`pranaav2k5`).

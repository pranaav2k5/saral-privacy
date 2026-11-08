# Threat model 0012: consent review (search by identifier, overview)

Status: draft, covers `apps/api/src/consent/consent-review.*` and the Consents page of the dashboard. Contract: `/v1/consents/search` and `/v1/consents/summary` in `docs/design/openapi.yaml`.

## Scope

An officer finds one person's consents by phone number or email address, and sees the organisation's consents in numbers. Out of scope: giving or withdrawing consent (threat model 0004), the rights-request queue (0007).

## Assets

A person's consent history, which says what they agreed to and when; the phone numbers and emails people gave, which are never stored; the audit log.

## Threats

| STRIDE | Threat | Mitigation | Proof |
|---|---|---|---|
| Information disclosure | Anyone with an API key or a session reads a person's consents. | Both routes need the `dpo` scope, so an administrator, an auditor and a publishable or `sdk` key get 403. | `consent-review.e2e.test.ts`: scopes; `pages.test.tsx` |
| Information disclosure | One organisation finds a person of another. | The pseudonym is keyed by the tenant, so the same number is another person elsewhere, and row-level security applies to every query. | `consent-review.e2e.test.ts`: another organisation |
| Information disclosure | The identifier appears in an address, a log, a stored record or an answer. | It travels in the body of a POST, is turned into a keyed HMAC and discarded, is not echoed (not even in a refusal), and the dashboard keeps it only in the box's own state. | `consent-review.e2e.test.ts` (no identifier or pseudonym in the answer; refusals do not echo it), `ConsentsPage.test.tsx` (not in storage or the address) |
| Information disclosure | The overview or the search shows more than needed. | The overview is counts only. A consent shows its purposes by key and whether agreed to, not the retention, the pseudonym or the principal id. | `consent-review.e2e.test.ts`: exact field lists, no personal data |
| Repudiation | An officer looks up a person and denies it. | A search that finds a person is the audit event `consent.searched`, naming the officer (or the key) and the person's internal id, never the identifier. | `consent-review.e2e.test.ts`: audit |
| Tampering | Searching creates a person, or a record that says someone exists. | The lookup only selects. A search for someone with no consent creates nothing and audits nothing. | `consent-review.e2e.test.ts` |
| Denial of service | A search or the overview loads a huge result. | At most 100 consents per search (one more is read to say there were more); the overview aggregates in the database and its period is 1 to 366 days. | `consent-review.e2e.test.ts`: 100 limit and boundary, days limit |
| Information disclosure | A person's existence is learned by guessing identifiers. | Searching is for the officer's role, is rate limited like every other call (threat model 0011) and, when it finds someone, is audited; searching for someone who is not there is not. | audit and rate-limit tests |

## Residual risks

- A search that finds nobody is not audited, so an officer could probe a list of identifiers for who is a customer and leave a trace only for the hits. Auditing misses would put an identifier-derived trace in the log for people who are not customers, so it was not done. The rate limit bounds the speed.
- The officer sees which purposes a person agreed to and when. That is the point of the screen. Anyone who holds an officer's session can see it too, so the session protections of threat models 0008 and 0009 matter here.
- The overview counts a purpose for each consent that agreed to it; a consent that was later withdrawn counts under withdrawn. A consent is `expired` only if something sets it to expired, and nothing does yet.
- Counts cover all consents ever recorded and are computed on every request. A very large organisation would want them kept, not recomputed.
- There is no funnel from banner views to consents, because views are not recorded.

Owner of residual risk: repository owner (`pranaav2k5`).

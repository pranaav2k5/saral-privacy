# Threat model 0013: breach workflow

Status: draft, covers `apps/api/src/breaches`, migration 0012 and the Breaches page of the dashboard. Contract: `/v1/breaches` in `docs/design/openapi.yaml`.

## Scope

Recording a personal data breach, preparing drafts for the Board and for the people affected, the officer's sign-off, recording that each was told, and closing. Out of scope: sending anything to the Board or to people (Saral does not), the audit log itself (threat model 0001) and authentication (0008).

## Assets

The incident record, which can describe people and what happened to their data; the integrity of the sign-off and of the times (they are evidence); the audit log.

## Threats

| STRIDE | Threat | Mitigation | Proof |
|---|---|---|---|
| Information disclosure | Someone without the role reads incidents, which can describe people. | Only the officer's and the administrator's scopes; others get 403. Row-level security keeps each organisation to its own incidents; another organisation's id is 404. | `breaches.e2e.test.ts`: reading, scopes; `breaches.test.ts` (database) |
| Information disclosure | Free text reaches the audit log or a webhook. | An audit entry holds the action, the times of the steps and a hash of the content, never the words. No webhook carries an incident. | `breaches.e2e.test.ts`: the audit check |
| Elevation of privilege | The administrator signs off, records that the Board was told, or closes, which is the officer's word. | Those routes need the officer's scope; the dashboard offers the buttons to the officer only. | `breaches.e2e.test.ts`, `BreachesPage.test.tsx` |
| Tampering | A report is changed after the officer signed it off, so the sign-off no longer describes the record. | The API refuses (409 `locked`), and the database refuses even for the owner. Sign-off keeps the hash of exactly the two drafts that were shown. | `breaches.e2e.test.ts`, `breaches.test.ts` |
| Tampering | The officer signs off drafts they did not read: someone corrects the report after the officer opened the drafts, and the sign-off records the new text under the officer's name. | The sign-off carries the hashes of the drafts the officer was shown, and is compared with the drafts as they are inside the locked transaction; if they differ the answer is 409 `drafts_changed` and nothing is signed. The dashboard waits for the drafts to be on screen and reads them again after a refusal. | `breaches.e2e.test.ts`: drafts not the ones shown; `BreachesPage.test.tsx` |
| Tampering | A step is rewritten (the Board's reference, the closing note, who signed off) or an incident is moved backwards or skipped ahead. | Each step's facts are written once, by the move into that step; the moves are one way; all of it is a database trigger and constraints. A test compares every state pair with the state machine in code. | `breaches.test.ts` |
| Tampering | An incident is deleted to hide it. | The application role has no `DELETE` on the table. | `breaches.test.ts` |
| Repudiation | An officer denies signing off, or telling the Board, or a report is edited quietly. | Every step and every correction is an audit entry naming who acted, taken in the same transaction. `signed_off_at` and `reported_at` are the server's time. | `breaches.e2e.test.ts`: the whole life in the audit log |
| Tampering | Two people act on one incident at the same moment. | A row lock inside the organisation's audit lock: one succeeds, the others get 409. | `breaches.e2e.test.ts`: four at once |
| Tampering | The time it was found is set late so that the Board's deadline is not missed on paper. | `discoveredAt` can be corrected only until sign-off, and each correction is an audit entry; `reportedAt` is the server's time, so the gap between found and reported shows; `boardNotifiedLate` is computed from the stored times. | `breaches.e2e.test.ts` |
| Spoofing | The record says the Board was told when it was not. | It is the officer's statement, with a reference the Board gave, audited. Saral cannot check it. See residual risks. | n/a |
| Denial of service | Many or huge incident records. | Fields are limited (4000 characters for the account, 2000 for the others, 20 kinds of data); the list is the newest 100; rate limits apply (threat model 0011). | `breaches.e2e.test.ts`, `breaches.test.ts` |

## Residual risks

- The 72-hour period and what has to be sent come from the plan's citation of Rule 7. The text of the Rule has not been read here. The lawyer advisor must confirm both, and review the two drafts, before this is shown to customers as advice. The page and the drafts say so.
- The hashes in a sign-off prove that the drafts were the ones the client had loaded, not that the officer read them; a client could send the hashes without showing the text. The dashboard shows the text before it offers the button.
- That the Board or the people were told is the officer's statement with the Board's reference. Saral has no connection to the Board's channel and cannot prove it. The audit entry proves who recorded it and when.
- The time it was found is typed by a person. Backdating or forward-dating is limited by the audit trail of corrections and by `reportedAt`, not prevented.
- There are no reminders before the deadline, no alert on the overview, and no email. An officer who does not open the page sees nothing. This should be built before a pilot.
- The free text of an incident can mention people. It is limited in size and kept out of audit entries and webhooks, but it is stored and shown to the officer and the administrator.
- Nothing exports an incident or the drafts as a document yet (the plan names PDF).

Owner of residual risk: repository owner (`pranaav2k5`).

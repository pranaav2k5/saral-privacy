# Threat model 0016: reminders

Status: draft, covers `apps/api/src/reminders` (the rules, the job and the command), migration 0015 (`reminders_sent` and the four new webhook events) and the Reminders group in the Integrations page.

## Scope

A job looks at each organisation's breaches and at the newest version of its record of processing, and sends a webhook event when the Board's deadline is within 24 hours or has passed, and when the next review is within 14 days or overdue. Out of scope: how a tenant's own system turns an event into an email or a message, and the webhook machinery itself (threat model 0005), which delivers the events.

## Assets

The words of an incident and of the record, which must not leave in an event. The audit log. The trust a person puts in the absence of a reminder.

## Trust boundaries

Job to database (one transaction for each organisation, as the application role), job to the webhook queue, and Saral to a tenant's endpoint.

## Threats

| STRIDE | Threat | Mitigation | Proof |
|---|---|---|---|
| Information disclosure | An event carries the words of an incident (what happened, which data, how many people) or of the record to an endpoint. | The data of an event is ids and dates only: `breachId` and `boardDeadline`, or `ropaVersionId`, `version` and `nextReviewDue`. A test reads the queued payload and finds no title or description, and another fails if a field is added. | `reminders.e2e.test.ts`: the first test and the delivery test |
| Information disclosure | One organisation's incident is sent to another's endpoint. | The work of an organisation is one transaction as the application role with that organisation's id set, so row-level security applies, and `reminders_sent` is under the same policy. | `reminders.e2e.test.ts`: "each organisation's incidents go to its own endpoints only"; `reminders.test.ts` (database) |
| Denial of service | The same reminder is sent every time the job runs, flooding an endpoint. | `reminders_sent` has a primary key on organisation, kind, id and stage, and the job checks it under the organisation's lock, so each reminder goes out once. Two runs at the same moment cannot both send it. | `reminders.e2e.test.ts`: "running again changes nothing", with six runs at once |
| Denial of service | A broken organisation stops everyone's reminders. | A failure rolls back that organisation's work only, is reported by id, and the others are done. | `reminders.e2e.test.ts`: "one organisation failing is reported" |
| Tampering | The application role is used to erase the record of what was sent, so a reminder goes out again, or to forge one. | The role can only insert and read `reminders_sent`. | `reminders.test.ts`: "never change or delete one" |
| Repudiation | A reminder was sent (or never sent) and nobody can say. | Each reminder that is queued is an audit entry `reminder.sent` by `system:reminder-job`, with a hash of the organisation, kind, id, stage and number of endpoints. A reminder that was not queued (nobody asked) is not an event, and is shown as waiting in the job's report. | `reminders.e2e.test.ts`: the audit test |
| Misleading assurance | A reminder is marked as sent when nobody could receive it, and the organisation that adds an endpoint later never hears of a deadline already near. | A reminder is recorded as sent only if at least one active endpoint was queued for it. With none it is counted as waiting and goes out once an endpoint asks. | `reminders.e2e.test.ts`: "with nobody asking" and "a disabled endpoint is not told" |
| Misleading assurance | A reminder is sent for an incident the Board has already been told about, or for an old version of the record. | Only incidents with the Board not told and still reported or signed off are considered, and only the newest version of the record. | `reminders.e2e.test.ts`: the told, closed and latest-version tests |
| Misleading assurance | A date on the boundary is decided the wrong way: a review due today called overdue, or a deadline called passed at the moment it arrives. | The rules are pure and tested to the boundary: a review due today is soon and overdue from the next UTC day, a deadline is soon up to and including the moment and passed after it, the same as the incident's own flag. | `rules.test.ts` |
| Spoofing | Someone signs up an endpoint for a reminder event to learn when another organisation has a breach. | An endpoint is registered by that organisation's administrator and receives only that organisation's reminders. | `webhooks.e2e.test.ts` (ownership), `reminders.e2e.test.ts` (isolation) |

## Residual risks

- The job has no scheduler in this repository. If nobody runs it (at least once an hour), no reminder is sent, and nothing says so. The deployment must run it and watch that it runs.
- A reminder is a webhook event: it reaches a person only through what the tenant's own system does with it. An organisation with no endpoint for these events, or an endpoint nobody watches, gets nothing. Saral sends no email or push itself.
- A breach reminder is "soon" for the last 24 hours and then "passed". A job that is not run for more than 24 hours can miss the first and send only the second. The 72-hour period itself is the plan's figure and is not confirmed against the Rule.
- The reminder for a review date uses UTC days, so an organisation in India sees a review due "today" begin at 05:30 local time.
- A reminder is sent once for each incident or version of the record and stage. If the endpoint was down for that delivery, the delivery follows the webhook retries and can fail for good; the administrator can send it again from the delivery log, but the job will not queue it again.
- The audit entries it writes are by `system:reminder-job` as the system, not a person, and a failing job that is retried every hour writes none until it succeeds.
- Saral does not know whether an incident the Board has been told about was recorded in Saral. An organisation that tells the Board and does not record it will keep being reminded.

Owner of residual risk: repository owner (`pranaav2k5`).

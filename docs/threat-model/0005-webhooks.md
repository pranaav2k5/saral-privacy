# Threat model 0005: webhooks (endpoints, outbox, delivery)

Status: draft, covers `apps/api/src/webhooks` and migration 0004. Contract: `webhooks` and `/v1/webhook-endpoints` in `docs/design/openapi.yaml`.

## Scope

Registering endpoints, queuing events with the consent that caused them, signing, delivering with retries, and the worker's database role. The delivery log for tenants, sending a failed delivery again, and switching off an endpoint that keeps failing (migration 0010) are in scope.

## Assets

The tenant's endpoint secrets; the integrity and confidentiality of events; the internal network the API can reach.

## Threats

| STRIDE | Threat | Mitigation | Proof |
|---|---|---|---|
| Elevation of privilege (SSRF) | A tenant registers a URL that makes the API call internal services or cloud metadata (169.254.169.254, 10.x, localhost). | https only, standard port, no credentials, fully qualified host or a public literal; every address the name resolves to must be public. IPv4 uses a blocklist of private and reserved ranges. IPv6 uses an allow-list: only global unicast (2000::/3) can be public, minus Teredo, 6to4, documentation prefixes, so mapped, compatible, NAT64, site-local and unique-local addresses are refused. | `url-guard.test.ts`, `webhooks.e2e.test.ts` |
| Elevation of privilege (DNS rebinding) | A host name is public at registration and later points to an internal address. | The delivery client re-checks the resolved addresses at connect time and connects to the checked address. | `http-client.test.ts`: default client refuses private addresses |
| Elevation of privilege (redirect) | A public endpoint answers 302 to an internal URL. | Redirects are never followed; a 3xx is a failed attempt. | `http-client.test.ts`, `webhooks.e2e.test.ts` |
| Spoofing | Someone sends fake events to a tenant's endpoint. | Every request carries `t=<time>,v1=<HMAC-SHA256>` keyed with the endpoint's secret; receivers reject old timestamps (5 minutes). | `signature.test.ts` (vector computed independently), `webhooks.e2e.test.ts` |
| Spoofing | A captured request is replayed. | The timestamp is inside the signature; the idempotency key is the delivery id. | `signature.test.ts` |
| Information disclosure | Events leak personal data. | Payloads hold ids and states only (consent id, receipt id, notice id, pseudonymous principal id, purpose keys). A test checks that no body contains the phone number. | `webhooks.e2e.test.ts` |
| Information disclosure | A copy of the database reveals signing secrets. | Secrets are not stored: each is derived from a server key, the endpoint id and a version. Shown once at creation. | `webhooks.e2e.test.ts`, `signature.test.ts` |
| Tampering | An event is recorded without being queued, or queued for an event that never committed. | The delivery row is inserted in the same transaction as the consent and its audit entry. A failed request queues nothing. | `webhooks.e2e.test.ts` |
| Elevation of privilege | The worker role reads more than it needs. | `saral_worker` has no access to consents, principals, receipts, keys, notices or the audit log, can update only outcome columns of deliveries, and cannot insert or delete. | `webhooks.test.ts` (database) |
| Denial of service | A slow or huge response from an endpoint ties up the worker. | A 10 second wall-clock deadline on the whole exchange (an idle timer alone is defeated by a server that trickles bytes); the response is dropped as soon as the status arrives; a poll that is still running makes the next one skip. | `http-client.test.ts` (trickle test), `runner.test.ts` |
| Denial of service (cross-tenant) | One slow endpoint, or one tenant with a large backlog, delays every other tenant's deliveries, or keeps a batch running past the visibility timeout so rows are claimed twice. | Endpoints are served at the same time (at most 10), the deliveries of one endpoint in order; an endpoint that exhausts a 60 second budget has the rest of its claimed rows released without counting an attempt; one claim takes at most 20 rows per tenant. | `webhooks.e2e.test.ts`: slow endpoint, budget, per-tenant claim |
| Denial of service | Many endpoints or events; two registrations racing past the cap. | At most 10 active endpoints per tenant, counted and inserted under a per-tenant lock; batches of 50 per poll. | `webhooks.e2e.test.ts`: 16 concurrent registrations give exactly 10 |
| Repudiation | Registering, disabling or rotating an endpoint cannot be traced. | `webhook.endpoint_created`, `webhook.endpoint_disabled` and `webhook.endpoint_rotated` are audit events. | `webhooks.e2e.test.ts` |
| Information disclosure | An endpoint nobody can turn off keeps receiving consent events (a mistyped URL, a lost secret, a domain later taken over). | `DELETE /v1/webhook-endpoints/{id}` disables it and frees its slot; events still waiting for it are closed; `rotate-secret` replaces a lost or leaked secret. | `webhooks.e2e.test.ts`: disabling and rotating |
| Elevation of privilege | The application role is used to rewrite delivery history (mark a failed delivery delivered, change what is sent or where, or touch another tenant's rows). | Migration 0010 gives it `UPDATE` on only `state`, `attempts` and `next_attempt_at`, and a trigger refuses every change except failed to pending with no attempts used and a due time within a minute; row-level security keeps it to its own tenant. The worker role is not held to the trigger. | `webhooks.test.ts` (database): sending a failed delivery again |
| Repudiation | Redelivering a delivery, or the switching off of an endpoint by Saral, cannot be traced. | `webhook.delivery_redelivered` and `webhook.endpoint_auto_disabled` are audit events; the second names `system:webhook-worker`, so it cannot be mistaken for an administrator's `webhook.endpoint_disabled`. | `webhook-deliveries.e2e.test.ts` |
| Denial of service | An endpoint that always fails costs the worker 15 attempts for every event, for ever. | After ten deliveries in a row have failed for good (none delivered among them), the endpoint is disabled and its waiting events are closed. | `webhook-deliveries.e2e.test.ts`: an endpoint that keeps failing |
| Denial of service (cross-tenant) | A worker that died while sending the 15th attempt leaves a row at 15 attempts; claiming it again would break the claim for every tenant. | A sweep at the start of every run closes such rows as failed, and the claim never selects rows at 15 attempts. | `webhooks.e2e.test.ts`: crashed 15th attempt |

## Residual risks

- Delivery is at least once. Receivers must de-duplicate on `Idempotency-Key`.
- The signing key hierarchy is the development provider until KMS exists. The webhook key is derived like the others.
- There is no overlap window for a rotated secret: the old one stops working at once.
- The delivery log shows the state, the attempts and the last error text of each delivery (our own short words such as `HTTP 500` or a connection error), never the payload or the signing secret. The error text comes from a tenant's own endpoint, so it can only tell the tenant about itself.
- An administrator can send a failed delivery again, but never more than the receiver already sees on a normal retry: the same payload and the same `Idempotency-Key`. A receiver that does not de-duplicate would act twice, as it could on any retry.
- A tenant's endpoint can still be slow or wrong; that only affects that tenant's own deliveries.
- Registration is limited per address and per key by the general rate limits (threat model 0011) and to 10 active endpoints, but has no limit of its own. A tenant can disable an endpoint (`DELETE`) and rotate its secret (`rotate-secret`); both are audit events. An endpoint cannot be enabled again, including one that Saral switched off.
- An endpoint is switched off only when a delivery fails for good and its ten most recent finished deliveries have all failed. Deliveries closed by the sweep (abandoned after 15 attempts by a crashed worker) do not trigger the check, so a tenant with few events and an endpoint that is down can take a long time to be switched off. The tenant sees `Failed` deliveries in the log meanwhile.
- The claim query repeats its due conditions on the locked row, because PostgreSQL rechecks only those after waiting on a concurrent claim. I could not build a deterministic test for that race; a repeated multi-worker test guards the behaviour.

Owner of residual risk: repository owner (`pranaav2k5`).

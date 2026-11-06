# Threat model 0010: notice publishing

Status: draft, covers `apps/api/src/notices` (`POST` and `GET /v1/notices`). Contract: `/v1/notices` in `docs/design/openapi.yaml`.

## Scope

An organisation's administrator publishes a new version of its privacy notice and lists its notices. Out of scope: the dashboard screens for it (not built), human legal review of templates (decision D16), and translation.

## Assets

The integrity of the notice text that every consent receipt points to, the audit log, and the organisation's standing with the Data Protection Board.

## Threats

| STRIDE | Threat | Mitigation | Proof |
|---|---|---|---|
| Tampering | A caller supplies notice text that is misleading, or that carries markup or line breaks which add structure. | The text is never taken from the caller. It is made from the reviewed template, and every value is one line of plain text with no control or bidirectional characters. | `notices-publish.e2e.test.ts` (rejections), `packages/notice` tests |
| Tampering | A published notice is edited later, so a receipt no longer matches the text the person saw. | A notice is never updated: the API role can only insert it, the hash is checked by the database, and an edit is a new version. | `notices-publish.e2e.test.ts` (older version keeps its text), migration 0001 |
| Tampering | A receipt names a recipient the notice does not disclose, or promises a retention the notice does not state. | A purpose that discloses to a third party must name an organisation listed in the notice. Receipt wording comes from the same request as the notice text. Retention in days is the caller's statement and is not compared with the words. | `notices-publish.e2e.test.ts` |
| Spoofing | A browser key or a server key for consent capture publishes notices. | The route needs the `tenant_admin` scope. Publishable, sdk, dpo and auditor keys are refused. | `notices-publish.e2e.test.ts` |
| Elevation of privilege | One organisation publishes into another's notices. | The organisation comes from the credential. Row-level security applies to the insert and the read. | `notices-publish.e2e.test.ts` |
| Repudiation | A publication cannot be traced to who made it. | `notice.published` is an audit event with the actor, the notice id, the version and the hash. | `notices-publish.e2e.test.ts` |
| Tampering | Two simultaneous publications get the same version, or the list order disagrees with the versions. | Publication runs under the per-organisation lock, takes the next version inside it, and stamps the time inside it. | `notices-publish.e2e.test.ts` (ten at once) |
| Information disclosure | Error messages echo what was submitted. | Messages are fixed text naming the field. | `notices-publish.e2e.test.ts` |
| Denial of service (of consent capture) | A notice is published whose largest receipt exceeds the 16 KiB limit, so every consent that grants all of it fails. | The size of the largest possible receipt is measured at publication (with room for the signature) and the notice is refused with 422 `receipt_too_large`. Not measured while the organisation has no receipt profile; grants then fail with `incomplete_setup`, which names the cause. | `notices-publish.e2e.test.ts` (a search for the exact limit, then a consent in full at that size) |
| Denial of service | A caller floods the organisation with notices. | Only an administrator can publish, each publication is audited, and the body size is limited. Requests are rate limited per key (threat model 0011) but there is no cap on notices per organisation. | `ratelimit.e2e.test.ts` |

## Residual risk

- An administrator can publish a notice that is legally poor. The platform marks every notice pending human review and does not judge the content. The privacy lawyer's review of templates is a launch gate (decision D16).
- There is no cap on notices per organisation. Rate limiting bounds how fast an administrator's key can publish (threat model 0011).
- Retention in days and retention in words are separate fields and can disagree. A person reading the notice sees the words, and the receipt says the days.

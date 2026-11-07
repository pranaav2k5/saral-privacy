# Threat model 0009: the staff dashboard

Status: draft. Covers `apps/web` (sign-in, session handling, the rights-request queue, the audit page, the notices page and the integrations page). The API side is covered by threat models 0005 (webhooks), 0007 (rights requests) and 0008 (staff authentication).

## Scope

A browser app used by two roles: the administrator and the data protection officer. It calls the Saral API with a session token and shows personal data (rights requests, contact details that the officer chooses to reveal) and secrets (webhook signing secrets, shown once). Out of scope: the principal-facing wallet and single sign-on.

## Assets

The session token, the contact details of people who made a request, webhook signing secrets, recovery codes, and the integrity of what the officer decides (a rejection or fulfilment cannot be undone).

## Trust boundaries

Browser to API (only with `Authorization: Bearer`, never cookies, `credentials: "omit"`); the person using the browser to the page; the dashboard origin to every other site.

## Threats

| STRIDE | Threat | Mitigation | Proof |
|---|---|---|---|
| Spoofing | A stolen session token is used from elsewhere. | Tokens last 15 minutes. The browser renews one only when the person is active in the last two minutes of its life, and the server stops renewal eight hours after sign-in. A 401 on a call made with the current session signs the tab out and says why; a late 401 or renewal from an older session cannot end or revive a newer one. | `lib/session.test.tsx` |
| Information disclosure | The token outlives the tab or leaks to other tabs and sites. | Kept in `sessionStorage` only (this tab, gone when it closes), never in `localStorage`, never in a cookie. Recovery codes and webhook secrets are held in component memory and never written to any storage; the create-endpoint action keeps no copy of the secret once it is acknowledged. If storage is blocked the session is kept in memory only. Requests use `cache: "no-store"`. | `lib/session.test.tsx`, `IntegrationsPage.test.tsx`, `SignIn.test.tsx` |
| Information disclosure | Cross-site request forgery. | There are no cookies. Requests carry a bearer token that a foreign page cannot read, and the browser sends `credentials: "omit"`. | `lib/api.test.ts`, `lib/session.test.tsx` |
| Information disclosure | A contact is exposed to anyone who looks at the screen or the page source. | The queue never contains contact details. They are fetched only when the officer presses a button, each press is an audit event on the server, and the screen says so. | `RequestsPage.test.tsx` |
| Information disclosure | The page address or content leaks to other sites. | `Referrer-Policy: no-referrer`, and the dashboard makes no third-party requests (system fonts, no analytics). | `lib/security-headers.test.ts` |
| Tampering | Clickjacking: another site frames the dashboard and tricks a click on "Reject" or "Disable". | `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`. | `lib/security-headers.test.ts` |
| Tampering | Script injection through text a person wrote (request details, endpoint address). | React escapes all text. There is no `dangerouslySetInnerHTML`, and the setup link is rendered only when it starts with `otpauth://`. | `SignIn.test.tsx`: the setup link |
| Tampering | An irreversible decision is made by a slip. | Fulfilling, closing and disabling an endpoint ask for a second, explicit confirmation. Rejecting needs a written reason. Rotating a secret says the old one stops at once. | `RequestsPage.test.tsx`, `IntegrationsPage.test.tsx` |
| Tampering | An older reply overwrites a newer choice, so the officer acts on the wrong request. | A reply to an earlier choice is dropped. | `RequestsPage.test.tsx`: a slow answer |
| Repudiation | A decision cannot be traced to a person. | Each action is an API call made with the person's session, which the server audits as `staff:<id>`. | threat model 0008 |
| Elevation of privilege | A role opens a page for another role. | The navigation shows only what the role can use, and a page for another role shows a refusal and makes no call. The API enforces the real split with scopes, so this is a convenience, not the control. | `Shell.test.tsx`, `app/pages.test.tsx` |
| Denial of service | A rendering or network failure leaves the officer with a blank page. | Every screen has loading, empty and failure states with a way to retry, and error text comes from the server in plain words. | each screen's tests |

## Residual risks

- **Script injection is not blocked by a content security policy.** Next.js inlines small scripts, and a policy that restricts scripts needs a nonce on every response, which would stop the pages being prerendered. Until that is decided, any cross-site scripting bug would let a script read the token from `sessionStorage`. Mitigations in place: no raw HTML, no third-party scripts, and short tokens. Decision needed before a pilot: accept, or move to per-request nonces.
- **The token is readable by page scripts** (it is in `sessionStorage`). The alternative, an HttpOnly cookie, brings back cross-site request forgery and needs a backend-for-frontend. Not chosen for the first version.
- **Sign-in has no per-address rate limit** (threat model 0008).
- **Staff accounts and recovery are done by an operator tool, not from the dashboard**, and staff cannot change their own password (threat model 0008).
- **Screens for notices, consent search and a consent funnel are not built.**
- **Sign-out is client-only.** There is no logout endpoint, so a copied token stays valid until it expires (at most 15 minutes).
- **A first-time authenticator set-up that is started again** replaces the unconfirmed secret on the server, so an authenticator entry scanned earlier stops working. The screen does not warn about this yet.
- **Recovery codes left on screen past the token's 15 minutes**, or a computer clock more than 15 minutes ahead of the server, make "I have saved these codes" sign the person straight back out without a message.

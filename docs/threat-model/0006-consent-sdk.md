# Threat model 0006: browser consent SDK

Status: draft, covers `packages/sdk-js` and the CORS settings of the API.

## Scope

The script a tenant puts on its pages: the dialog, the requests it makes, and what it keeps in the browser. Out of scope: the tenant's own page, its other scripts, and how the script is hosted (not decided).

## Assets

The person's choice and its integrity; the person's email or phone number while they type it; the publishable key.

## Trust boundaries

Tenant page to SDK (the page is trusted to configure it, but not to be bug-free); SDK to API (public internet); the person's browser storage.

## Threats

| STRIDE | Threat | Mitigation | Proof |
|---|---|---|---|
| Elevation of privilege (XSS) | Purpose labels or descriptions contain markup, or the SDK builds HTML from strings. | Every node is built with `textContent`; the source must not contain `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval` or `new Function` (a test scans it). | `sdk.test.ts`: markup shown as text; source scan |
| Information disclosure | A secret key is shipped in a web page. | `init` refuses `sk_` keys with a message that says why; the API gives publishable keys only the `sdk` scope (database CHECK) and lets them be limited to origins. | `sdk.test.ts`; `lookup.test.ts`; `auth.e2e.test.ts` |
| Information disclosure | The identifier is stored in the browser or leaks through the page. | It is held in a closure only while needed and sent once; storage holds the decision, ids and per-purpose choices only. A test searches the stored value for the identifier. | `sdk.test.ts`: what the browser keeps |
| Information disclosure | Cookies carry credentials to the API. | Requests use `credentials: "omit"`; the API's CORS never sets `Allow-Credentials`. Authentication is by the bearer key only. | `sdk.test.ts`; `cors.e2e.test.ts` |
| Tampering | A site silently turns purposes on by default. | The dialog renders every purpose off; accepting sends exactly what is switched on. (The host page can of course change its own page; the API records the collection method and the notice hash.) | `sdk.test.ts`: banner |
| Repudiation | A person says they never agreed. | The API issues a signed receipt and a chained audit entry for every grant and withdrawal (threat models 0001, 0002, 0004). | API tests |
| Spoofing | Someone submits a consent for another person's identifier. | **Not mitigated**: nothing proves the person controls the identifier (see threat model 0004). | open risk |
| Denial of service | A double click or a retry storm sends many requests. | Buttons are disabled while a request is in flight, and the guard is set before the first `await`. | `sdk.test.ts`: second click |
| Elevation of privilege | CORS is mistaken for authorisation. | CORS reflects any origin because the SDK runs on tenants' sites. Keys and per-key origin lists are enforced on every request. | `cors.e2e.test.ts`: key origin list |
| Tampering (supply chain) | The script is replaced on its way to the page. | Not solved: hosting and Subresource Integrity are not decided. Tenants should pin with `integrity` once published. | open item |
| Spoofing (clickjacking) | The dialog is framed or covered by another page. | Not addressed by the SDK; tenants should send `frame-ancestors` and `X-Frame-Options` for their own pages. | open item |

## Residual risks

- Consent forgery through publishable keys (above) and no rate limiting.
- The Hindi text is a draft without a native-speaker review.
- No age gate for children's data (DPDP Rule 10) yet.
- The SDK trusts the page that loads it: a compromised page can read what the person types.

Owner of residual risk: repository owner (`pranaav2k5`).

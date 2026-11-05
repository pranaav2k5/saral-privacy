# @saral/sdk-js

The browser consent SDK. It shows a consent dialog, sends the person's choices to the Saral API, and lets them withdraw as easily as they gave consent. No dependencies. About 6 kB gzipped (budget: 25 kB).

Not published yet. Build it with `pnpm --filter @saral/sdk-js build`: `dist/saral-privacy.global.js` for a script tag, `dist/saral-privacy.mjs` (ESM) and `dist/saral-privacy.js` (CJS) for npm use.

## Use

```html
<script src="saral-privacy.global.js"></script>
<script>
  const consent = SaralPrivacy.init({
    publishableKey: "pk_...",              // never a secret key (sk_...): init refuses it
    apiBase: "https://api.example.org",    // https; http only for localhost
    noticeId: "<uuid of the published notice>",
    purposes: [
      { key: "analytics", label: "Analytics", description: "How the app is used" },
      { key: "marketing", label: "Product updates", description: "Emails about new features" },
    ],
    locale: "en",                          // "en" or "hi" (the Hindi text is a draft pending review)
    // identifier: "person@example.org",   // if the page already knows the person; otherwise the dialog asks
    onChange: (state) => console.log(state), // the decision, or null after a withdrawal
  });
</script>
```

The `key` of every purpose must match a purpose defined in the published notice; the API takes retention and receipt details from the notice, never from the page.

## What it does

- Opens on the first visit with **every purpose off**. "Reject all", "Accept selected" and "Accept all" are the same kind of button with the same style: rejecting is exactly as easy as accepting. Rejecting sends nothing and is remembered on this device.
- Accepting sends `POST /v1/consents` with the publishable key (no cookies) and keeps only the decision, the consent and receipt ids and the per-purpose choices in `localStorage`. **It never stores the email address or phone number.** If storage is blocked, it keeps the decision in memory for the page.
- A "Privacy choices" button stays on the page. It opens the person's choices, and **Withdraw consent** is one click (plus the identifier if the page did not supply it). Withdrawal goes by identifier and notice, not by a stored consent id, so it works on another device or after the browser was cleared, and it withdraws every consent the person has for the notice.
- If the network fails or the server refuses, nothing is stored, the dialog says so in plain words, and the person can try again.
- Accessible by construction: a modal `dialog` with a labelled title, a focus trap, Escape to close, focus returned to where it was, visible focus, real switches, a live region for errors, and no motion for people who ask for less.
- Everything is built with `textContent`; the source never uses `innerHTML` (a test enforces it). Labels and descriptions with markup show as text.
- An `identifier` callback that throws, rejects or returns something else is treated as "no identifier": the dialog says so and stays usable.
- Loading the script does not touch the DOM, so it is safe in server-side rendering; the DOM is used only when `init` is called.

## API

`init(options)` returns `{ open(), close(), getConsent(), withdraw(), destroy() }`. `getConsent()` is the stored decision (`granted` or `refused`) or `null`. A second `init` on the same container replaces the first.

## Not built yet

- The age gate hook for children's data (DPDP Rule 10): see `docs/compliance/traceability.md`.
- Proof that the person controls the identifier they type (an OTP or a signed claim from the site's server). Until then a publishable key can be used to submit a consent for someone else's identifier; see `docs/threat-model/0004-consent-api.md`.
- Hosting, Subresource Integrity hashes and a versioned CDN path. Tenants should pin the script with an `integrity` attribute once it is published.
- Human-reviewed Hindi text, and the other Indian languages.

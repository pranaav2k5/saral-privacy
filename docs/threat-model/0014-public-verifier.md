# Threat model 0014: public receipt verifier

Status: draft, covers `apps/site/src/lib/receipt-verify.ts`, `apps/site/src/components/VerifyReceipt.tsx` and the `/verify` page. The signing side is threat model 0002.

## Scope

A person pastes a consent receipt into a public page and their browser checks its signature against the key set that the API publishes. Out of scope: issuing receipts (0002), the key set endpoint's own availability, and whether a consent has since been withdrawn.

## Assets

The person's receipt, which holds a pseudonymous id and what they agreed to; the trust a person places in a "valid" answer; the integrity of the key set.

## Threats

| STRIDE | Threat | Mitigation | Proof |
|---|---|---|---|
| Spoofing | A receipt that is correctly signed but is not what the server would issue (no `iat`, no principal id, an http policy address) is shown. | The page applies every rule of the server's `validateClaims`, and shows nothing from a receipt that fails one. A test runs both over 54 payloads and fails if they differ. | `receipt-parity.test.ts` |
| Spoofing | A forged receipt is shown as valid. | RS256 only (no `none`, no HMAC, no other algorithm), the `kid` must be in the key set, the signature is checked with Web Crypto against that key, and keys that are not RSA, are for another use or algorithm, or are weaker than 2048 bits or an exponent under 65537 are refused. | `receipt-verify.test.ts`: algorithm, kid, key, weak key, signature, changed content |
| Spoofing | A receipt signed by an attacker's own key set is shown as valid. | The page takes the key set only from the API address it is built with (shown on the page), never from the receipt. A receipt cannot name where its keys are. | `VerifyReceipt.test.tsx`: only the key set is fetched |
| Tampering | A receipt is changed after signing. | Any change of any byte of the header or payload fails the signature. Encodings that decode to the same bytes but are not canonical are refused. | `receipt-verify.test.ts` |
| Information disclosure | The receipt, which can link a person to a consent, leaves the browser. | The page makes one request, for the public key set, with no cookies and no body; the receipt is never in an address. A test reads every request. A real-browser run confirmed it. | `VerifyReceipt.test.tsx` |
| Elevation of privilege (cross-site scripting) | A signed receipt carries markup that runs in the page. | Every value is rendered as text by React. The policy address and the withdrawal address are text, never links. | `VerifyReceipt.test.tsx`: markup and policy address |
| Denial of service | A huge paste, a huge key response or a key with enormous numbers stalls the page or fills its memory. | The pasted text is limited to 16 KiB before it is looked at. The key response is read as a stream and dropped at 64 KiB (or when it says it is larger), the key set is limited to 100 keys, a key's numbers are refused above 2048 and 16 characters before they are decoded, and the fetch has a 10 second limit. | `receipt-verify.test.ts`, `key-set.test.ts` |
| Misleading assurance | The result of one receipt is shown beside text that was edited afterwards, or a success is not noticed by a screen reader. | Editing clears the result and a check that finishes after an edit is dropped; a success is announced in a live region and focus moves to it. | `VerifyReceipt.test.tsx` |
| Repudiation / misleading assurance | "Valid" is read as "the consent still stands" or "this is the person". | The page says what a valid signature does not show: who the person is, whether the consent is still in force, and the notice text. | `VerifyReceipt.test.tsx` |
| Misleading assurance | A failure to fetch the keys is read as a bad receipt, or a bad receipt as a network fault. | The two outcomes have different words, and the first says it says nothing about the receipt. | `VerifyReceipt.test.tsx` |

## Residual risks

- The page proves that a receipt was signed by a key in the set and not changed. It cannot say that the consent has not been withdrawn since. There is no public withdrawal status check, deliberately, because it would let anyone with a receipt probe a person's consent state.
- The page is only as trustworthy as the site that serves it and the API address it was built with. Someone who controls the site could make it say "valid" for anything, so running in the browser does not make the answer independent of the site, and the page says so. A person who needs that independence repeats the check with their own tool and a public key from a source they trust (the algorithm, the key set and the rules are documented).
- The key set is fetched at each check and not pinned, so a key that was removed makes older receipts show "not issued by this service". There is no key history yet.
- The notice fingerprint cannot be matched to the notice text on this page. A public check of the text against the fingerprint is not built.
- The page and `packages/receipts` have separate code for the same rules, because the server's uses Node's crypto. `receipt-parity.test.ts` compares their verdicts on a fixed table of payloads, so a rule added to one and not the other fails only if the table has a case for it. Add a case with every rule.

Owner of residual risk: repository owner (`pranaav2k5`).

# Threat model 0002: consent receipt issuance and verification

Status: draft, covers the library built in `packages/receipts`. The API route, KMS signer and public verifier page extend it later.

## Scope

In scope: building a Kantara KI-CR-v1.1.0 receipt, signing it as an RS256 JWT, publishing the public keys as a JWKS, and verifying a receipt. Out of scope for now: where the signing key lives (KMS adapter), the HTTP routes, receipt delivery by email or wallet.

## Assets

The receipt signing key; the integrity of receipts (evidence of what a principal agreed to); the principal's privacy.

## Trust boundaries

Browser or SDK to API; API to KMS; a relying party (an auditor or the principal) fetching the JWKS over HTTPS.

## Threats

| STRIDE | Threat | Mitigation | Proof |
|---|---|---|---|
| Spoofing | A forged receipt is presented as ours. | RS256 signature checked against our JWKS; only `kid`s in the key set are accepted. | `jwt.test.ts`: tampered payload, swapped kid, unknown kid |
| Spoofing | Algorithm confusion: `alg: none`, or HS256 using the public key as the secret. | Only `RS256` is accepted, checked before anything else. | `jwt.test.ts`: none, HS256, other algs |
| Spoofing | An attacker supplies a weak or odd key in the JWKS (small modulus, exponent 3, wrong `use` or `alg`). | Keys under 2048 bits, exponents under 65537, and keys not marked for RS256 signatures are refused. | `jwt.test.ts`: weak key, bad key |
| Tampering | Payload or header edited after signing. | The signature covers `header.payload`; base64url must be canonical, so re-encodings are refused. | `jwt.test.ts`: tampering, non-canonical encoding |
| Tampering | Our own code signs a malformed receipt. | `signReceipt` validates the claims first. | `jwt.test.ts`: signing refuses invalid claims |
| Information disclosure | A receipt leaks personal data. | `piiPrincipalId` must be a pseudonymous UUID; building a receipt with an email or phone number there is refused. Controller contact details are business details. | `claims.test.ts`: principal id rules |
| Information disclosure | The JWKS leaks private key members. | `buildJwks` throws on private members and copies only public ones. | `jwks.test.ts` |
| Repudiation | The controller denies issuing a receipt. | The receipt is signed; the consent record behind it is bound into the audit chain (threat model 0001). Linking the receipt id into the audit entry is done in the consent API. | open item for the API task |
| Denial of service | Huge tokens sent to the verifier. | Tokens over 16 KiB are rejected before parsing. | `jwt.test.ts` |
| Elevation of privilege | A receipt is accepted as a login credential. | Receipts are evidence, never credentials. The API must not authenticate anyone from a receipt. | design rule for the API task |
| Key compromise | The signing key leaks. | Key lives in KMS and is never exported; rotation by adding a new `kid` to the JWKS while old keys stay for verification. Receipts signed with a compromised key must be re-attested. | open item for the KMS adapter |
| JWKS cache poisoning | A relying party fetches the JWKS over an untrusted path. | HTTPS only, published from our own domain, short cache lifetime; the public verifier pins the domain. | open item for the public verifier |

## Residual risks

- The specification gives no JWT profile, so third parties may not recognise our token format.
- A receipt shows what was displayed and accepted only if the notice is also preserved. The consent record binds the notice's SHA-256 (`noticeSha256`).
- Time: `consentTimestamp` and `iat` come from our server clock.

Owner of residual risk: repository owner (`pranaav2k5`). Review again with the consent API.

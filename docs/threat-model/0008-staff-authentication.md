# Threat model 0008: staff authentication

Status: draft, covers `apps/api/src/staff`, migration 0007 and the session path of the authentication guard (ADR 0004). Contract: `/v1/auth/*` in `docs/design/openapi.yaml`.

## Scope

Signing in with a password and an authenticator code, recovery codes, session tokens, refresh, and how a session maps to scopes. Out of scope: creating accounts and resetting passwords (operators only, no route), the dashboard's own storage of the token, and single sign-on.

## Assets

Staff accounts (they can read consents, rights requests and contact details), the authenticator secrets, the session signing key.

## Threats

| STRIDE | Threat | Mitigation | Proof |
|---|---|---|---|
| Spoofing | Password guessing or credential stuffing. | scrypt with pinned parameters; five failures lock the account for 15 minutes (audited); MFA is required for any session. **No per-address or per-network rate limit yet.** | `staff.e2e.test.ts` |
| Spoofing | The login reveals which accounts exist. | Every failure is the same 401 with the same body, and the password is always hashed, so timing does not say whether an account exists, is locked or is disabled. | `staff.e2e.test.ts`: failing to sign in |
| Spoofing | A stolen password alone gives access. | The password gives only a challenge token, rejected everywhere else; a session needs a code. | `staff.e2e.test.ts`: tokens |
| Spoofing | A captured authenticator code is replayed. | The newest accepted step is stored; an equal or older code is refused (RFC 6238 vectors in `totp.test.ts`). | `totp.test.ts`, `staff.e2e.test.ts` |
| Spoofing | A forged or altered session token. | HMAC-SHA256 with a server key, constant-time check, a purpose field (session or challenge), expiry, and a check on every request that the account exists, is enabled, has finished MFA set-up, has the same role and the same session version. | `session-token.test.ts`, `staff.e2e.test.ts` |
| Elevation of privilege | A session is used as an API key, or the reverse; a role reaches another role's routes. | Sessions get scopes from the role only (never `sdk`); the guard's deny-by-default and scope check apply to both; a DPO cannot use admin routes and the reverse. | `staff.e2e.test.ts`: what each role may do |
| Elevation of privilege | A session from one tenant is used against another. | The token names the tenant, and the person is looked up inside that tenant under row-level security; the same token moved elsewhere finds no one. | `staff.e2e.test.ts` |
| Information disclosure | The password, email or authenticator secret is stored or returned in the clear. | Passwords only as scrypt hashes; email and authenticator secrets sealed; recovery codes only as HMACs; a test searches every table. `/v1/auth/me` returns no secrets. | `staff.e2e.test.ts`: what is stored |
| Repudiation | Who did what. | Sign-in, authenticator set-up and lock-out are audit entries; actions by a signed-in person are audited as `staff:<id>`. | `staff.e2e.test.ts` |
| Tampering | A person who should be out is still in. | Disabling an account or bumping its session version ends all its sessions on the next request. | `staff.e2e.test.ts` |
| Denial of service | An attacker locks a real person out by failing their password five times. | Accepted trade-off: lock-out is per account. The lock lasts 15 minutes. | open item |
| Denial of service | Expensive hashing used to tie up the server. | Each login costs one scrypt run (about 32 MiB); there is no request rate limit yet. | open item |

## Residual risks

- No rate limiting by address, and lock-out lets an attacker lock someone out.
- A stolen session token works until it expires (15 minutes), is refreshed up to eight hours, or the account is disabled. There is no logout route that revokes one session; bumping the session version ends them all.
- Accounts are created and recovered, and API keys and the controller profile are managed, by the operator tool (`apps/api/src/operator`). Key tokens are printed once and never stored; a lost key is revoked and replaced. It runs with database-owner credentials, so its actions are not in the organisation's audit log, and a person who loses their authenticator and recovery codes must ask an operator. It needs the development key provider, so it cannot be used in production until KMS exists. A generated password cannot be changed by the person, only reset by an operator.
- The development key provider derives the session and index keys from one secret.
- The dashboard must keep the token out of script-readable storage if it can (it cannot with a bearer token in a single-page app; revisit with a cookie-based session).

Owner of residual risk: repository owner (`pranaav2k5`).

# ADR 0004: Staff authentication (password, authenticator code, session)

Status: accepted
Date: 2026-11-06

## Context

The DPO dashboard and the admin tools need people to sign in. `docs/PLAN.md` requires MFA for admin and DPO. Until now the `dpo` and `tenant_admin` scopes were secret API keys. The decisions below fix the parameters so they are not argued again at each change.

## Decision

- **Accounts** are created by operators (`createStaffUser`, using a database owner connection). The API role can only record sign-in progress. There is no self-registration and no password reset route yet.
- **Passwords**: scrypt, N=32768, r=8, p=1, 16-byte salt, 64-byte key, NFKC-normalised, stored as `scrypt$N$r$p$salt$hash`. These parameters are pinned: a stored hash with weaker ones never verifies, and the database refuses to store one. Raising them means adding a new version, never editing these. Policy: 12 to 128 characters, not the email address, not one character repeated. No composition rules.
- **MFA**: TOTP per RFC 6238 (SHA-1, six digits, 30 second step, one step of drift either way), checked against the RFC test vectors. A code works once: the newest accepted step is stored and an older or equal one is refused. The first accepted code confirms the authenticator and returns eight single-use recovery codes, shown once and stored only as HMACs. Authenticator secrets and email addresses are sealed with AES-256-GCM (the contact key), bound to the account.
- **Sign-in is two steps.** The password gives a 5 minute **challenge** that cannot be used as a session (the token carries its purpose). Only a correct code gives a **session**. A session without MFA does not exist.
- **Failures are uniform.** An unknown organisation, unknown email, wrong password, disabled account and locked account give the same 401 and the password is always hashed, so timing does not say which. Five failures (password or code) lock the account for 15 minutes and write an audit entry. There is no per-address rate limit yet.
- **Session token**: an opaque signed token (`st_v1.<payload>.<HMAC-SHA256>`), not a JWT. It is made and checked by the API with a server key, so there is no algorithm field to confuse and nothing a third party needs to verify. It lasts 15 minutes and can be refreshed until eight hours after the person last signed in with a password and a code. Every request re-reads the account, so disabling a person or bumping `session_version` ends their sessions at once. The first RS256 design in `docs/design/LLD.md` was replaced by this for those reasons.
- **Scopes by role**: `tenant_admin` gets `tenant_admin` and `auditor`; `dpo` gets `dpo` and `auditor`. Staff sessions never get `sdk`. Audit entries for a staff action name `staff:<id>`.

## Consequences

- No refresh token is stored, so a stolen session works until it expires or the account's `session_version` changes.
- A person who loses both the authenticator and the recovery codes needs an operator.
- Operators need a way to create accounts and to reset a password or authenticator: only the creation helper exists, there is no command-line tool or reset flow yet.
- Revisit when single sign-on is needed, or when browsers need a cookie-based session (a dashboard on another origin would otherwise hold the token in script-readable storage).

# Contributing

## Local setup

1. Install Node 24 LTS (Node 22.12 or newer also works), pnpm 11 (the exact version is pinned in `package.json`), Python 3.13 with [uv](https://docs.astral.sh/uv/), Terraform 1.10 or newer, and Docker.
2. `pnpm install`
3. `pnpm verify` runs lint, type checks, tests, and builds for every TypeScript workspace.
4. For the ML service: `cd apps/ml && uv sync && uv run pytest`.
5. Local database: `pnpm db:up` (PostgreSQL 16 on 127.0.0.1:5432) and `pnpm db:down`. Copy `.env.example` to `.env` if you need local environment variables.

## Workflow

- Trunk-based development on `main`. Branch from `main`, keep branches short-lived, open a pull request, and merge once CI is green and a reviewer has approved. Branch protection is not configured by the repository; this is a convention.
- Commit messages: a short imperative subject with a type prefix (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
- Write the failing test first, watch it fail, then make it pass.

## Public repository rules

- This repository is public. Never put secrets, private keys, cloud account IDs, real personal data, customer names, or unreleased commercial terms in code, tests, fixtures, issues, pull requests, or commit messages.
- Test keys are generated at runtime. Test data uses obviously fake values (`example.org`, `.invalid` domains, made-up UUIDs).
- Commits are authored and committed by `pranaav2k5`. Check with `git log --format='%an|%cn' origin/main..HEAD` before pushing.

## Definition of Done

A change is done when it has:

- unit tests, and an integration test where it crosses a boundary,
- a threat-model checkbox ticked in the pull request (and a model in `docs/threat-model/` for epics of 5 story points or more),
- a RoPA-impact check (does this add personal data, a purpose, or a retention period?),
- an audit event for every user-facing action,
- the traceability matrix in `docs/compliance/traceability.md` updated if it touches a DPDP requirement.

## Data-protection rules for code

- Every new personal-data field needs a purpose, a retention period, and a RoPA entry.
- Use pseudonymous identifiers everywhere. Raw phone numbers and emails live only in the encrypted contact table.
- A request to use data for a purpose without granted consent returns 403.
- Never commit secrets. `.env.example` may hold only non-secret development values. Secret scanning runs on every pull request.

## Not legal advice

Features and templates are tools for customers. Do not describe them as a guarantee of legal compliance in code, copy, or contracts.

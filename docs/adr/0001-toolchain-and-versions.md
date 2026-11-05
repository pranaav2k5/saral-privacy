# ADR 0001: Toolchain and versions for the repository scaffold

Status: accepted
Date: 2026-11-05

## Context

`docs/PLAN.md` fixes the stack at a high level (decision D4): Next.js, NestJS, FastAPI, PostgreSQL 16, AWS ap-south-1, Terraform, no Kubernetes. Building the scaffold meant choosing concrete versions and tools. Several choices differ from what the plan text or its source documents assumed, because the source documents were written in May 2026 and the ecosystem moved.

## Decision

**Languages and runtimes**
- Node 24 LTS in `.nvmrc`, Docker images, and CI. `engines.node` is `>=22.12` and CI also runs Node 22, because Node 22 reaches end of life on 2027-04-30 and contributors may still be on it.
- Python 3.13 managed by uv.
- TypeScript 6.0.x for the pnpm workspace packages. TypeScript 7 is not used yet because ts-jest 29 and typescript-eslint do not support it. Revisit when both do.

**Frameworks**
- Next.js 16 (the current major at install time), not Next.js 14 as D4 said. Vendor sources report Next.js 14 reached end of life on 2025-10-26 and Next.js 15 on 2026-10-21. Confirm against the official Next.js support policy before relying on those dates. The three Next.js apps keep the generator's ESLint 9 and TypeScript 5 because `eslint-config-next` targets them.
- NestJS 12. It is ESM-only, so `apps/api` is an ES module package (`"type": "module"`, `.js` suffixes on relative imports) and its Jest run uses ESM mode with `NODE_OPTIONS=--experimental-vm-modules` through `cross-env`. Jest prints an ExperimentalWarning on each run. Revisit when Jest supports ESM natively or Node 24.9+ is the minimum.
- FastAPI with uvicorn. Tests use `httpx2`, because Starlette's test client warns when used with `httpx`.

**Package management and tests**
- pnpm 11.0.9, pinned through `packageManager`. pnpm blocks dependency build scripts by default. The ones we denied (`@parcel/watcher`, `esbuild`, `sharp`, `unrs-resolver`) are listed under `allowBuilds` in `pnpm-workspace.yaml`.
- Jest for every TypeScript workspace and pytest for Python, as in `docs/PLAN.md` section 6.4.

**Browser SDK**
- tsup builds an IIFE for script tags, plus ESM and CJS for npm consumers. There is no true UMD build because tsup does not produce one. The 25 kB gzipped budget applies to the IIFE file and is enforced by size-limit.

**Infrastructure**
- Terraform 1.10 or newer, AWS provider `~> 6.0`, tests with the native `terraform test` and `mock_provider`.
- The audit anchor bucket module uses Object Lock in `COMPLIANCE` mode in prod and `GOVERNANCE` mode in dev and staging, with 7-year default retention (decision D11). AWS now allows enabling Object Lock on an existing bucket, so bucket creation order is not a one-way door, but creating it locked in Terraform stays the rule.
- The bucket uses AES256 until the KMS module exists. Four Checkov checks are suppressed inline with reasons (access logging, cross-region replication, customer-managed KMS key, event notifications). Each one needs a resource that a later plan adds.
- Terraform state locking uses S3-native `use_lockfile`, not a DynamoDB table.
- This scaffold contains only the audit anchor module and the environment stacks. KMS, RDS, ECS, and networking modules belong to the week 3 to 4 plan.

**Containers**
- The API image is built from the repository root with `pnpm deploy --legacy --prod`, because pnpm 10 and later refuse a normal deploy without `inject-workspace-packages`. The API has no workspace dependencies yet. Revisit when it does.

## Consequences

- Two ESLint and TypeScript versions coexist (Next.js apps and everything else). This is acceptable until Next.js supports ESLint 10 and TypeScript 6.
- Node 22 support ends in April 2027. Raise `engines.node` and drop it from the CI matrix then.
- If ts-jest adds TypeScript 7 support, upgrade TypeScript across the workspace in one change.

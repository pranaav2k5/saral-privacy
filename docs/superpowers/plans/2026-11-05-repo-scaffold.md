# Repo Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the empty `saral-privacy` repo into a monorepo skeleton where every workspace builds, lints, type-checks, and passes one smoke test locally and in CI, with no product features yet.

**Architecture:** A pnpm workspace holds the TypeScript parts (`apps/api`, `apps/web`, `apps/wallet`, `apps/site`, `packages/schemas`, `packages/sdk-js`). The ML service in `apps/ml` is a separate uv-managed Python project. `infra/terraform` holds one real module (the audit-anchor bucket) plus per-environment stacks. One GitHub Actions workflow runs all of it plus secret and vulnerability scans.

**Tech Stack:** Node 24 LTS, pnpm 11, TypeScript, Jest, NestJS, Next.js (current supported major), tsup, size-limit, Python 3.13, FastAPI, uv, ruff, pytest, Terraform 1.15 with native `terraform test`, Docker Compose with PostgreSQL 16, GitHub Actions, gitleaks, Trivy, Checkov.

**Spec:** `docs/PLAN.md`, mainly section 14 (layout), section 5 (architecture), sections 6.4 and 6.5 (testing, CI), decisions D4, D6, D11, D13. This plan builds no P0 or P1 feature. Database schema, row-level security, auth, audit log, deployment, and KMS/RDS/ECS Terraform modules belong to the weeks 3 to 8 plans.

## Global Constraints

- Production runs in AWS `ap-south-1` only. No Kubernetes.
- Database is PostgreSQL 16.
- Audit-anchor bucket: Object Lock on, default retention 7 years, mode `COMPLIANCE` in `prod` and `GOVERNANCE` in `dev` and `staging` (D11).
- `canonical_schema_version` starts at `1`. Receipt spec string is exactly `KI-CR-v1.1.0`.
- Consent SDK browser bundle: 25 kB gzipped or less.
- Secrets never live in git or in committed env files. Only `.env.example` with non-secret dev values may be committed.
- Trunk-based development on `main`. Short-lived branches, pull requests, no direct pushes after this scaffold lands.
- Secret scanning and dependency scanning are on from the first commit.
- Tests: Jest for TypeScript, pytest for Python.
- Version calls that deviate from the spec text (record in ADR-0001, Task 9):
  - D4 says Next.js 14. Vendor sources report Next.js 14 reached end of life on 2025-10-26 and Next.js 15 on 2026-10-21. Use the newest supported major (check `pnpm view next version` and the official Next.js support policy at install time). Flag to the owner.
  - Node 24 LTS in `.nvmrc`, Docker, and CI. Node 22 (local machine has 22.22.2) must also work, so `engines.node` is `>=22.12`.
  - The SDK ships an IIFE build for script tags plus ESM and CJS for npm, not a true UMD, because tsup has no UMD output. The 25 kB budget applies to the IIFE file.

## Review Focus

1. A `.env` or `.env.local` file is committed by accident. Expected: git ignores both, only `.env.example` is tracked, and gitleaks flags a planted fake AWS key. (Task 1)
2. SDK bundle grows past budget. Expected: the size check fails. (Task 2)
3. `PORT` is set to something non-numeric or out of range. Expected: the API refuses to start with a clear error, it does not listen on a random port. (Task 3)
4. Someone passes `environment = "prod"` with retention under 1 year, or an unknown environment name, to the Terraform module. Expected: validation error, no plan. (Task 8)
5. A contributor installs on Node 22 while CI uses Node 24. Expected: install and tests pass on both. (Task 10 runs a CI matrix of both.)

---

## File Structure

```
package.json, pnpm-workspace.yaml, .nvmrc, .editorconfig, .gitignore,
tsconfig.base.json, eslint.config.mjs, .prettierrc.json, renovate.json,
docker-compose.yml, .env.example, CODEOWNERS (.github/), CONTRIBUTING.md, SECURITY.md
packages/schemas/      version constants (the frozen contract lives here later)
packages/sdk-js/       browser SDK shell, size budget
packages/verifier/     README only until the audit-log plan
apps/api/              NestJS, GET /healthz, Dockerfile
apps/ml/               FastAPI, GET /healthz, Dockerfile
apps/web/              Next.js B2B dashboard shell
apps/wallet/           Next.js consumer wallet shell
apps/site/             Next.js marketing and free notice tool shell
infra/terraform/modules/audit_anchor_bucket/   S3 + Object Lock + tests
infra/terraform/envs/{dev,staging,prod}/       stacks calling the module
docs/adr/, docs/threat-model/, docs/compliance/
.github/workflows/ci.yml, .github/pull_request_template.md
```

Ports: web 3000, wallet 3001, site 3002, api 4000, ml 8000, postgres 5432.

Every TypeScript workspace exposes these scripts so root `pnpm -r` commands work: `lint`, `typecheck`, `test`, `build`.

---

### Task 1: Root tooling and `packages/schemas`

**Files:**
- Create: root `package.json`, `pnpm-workspace.yaml`, `.nvmrc`, `.editorconfig`, `.gitignore`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc.json`, `renovate.json`
- Create: `packages/schemas/package.json`, `packages/schemas/tsconfig.json`, `packages/schemas/jest.config.cjs`, `packages/schemas/src/index.ts`
- Test: `packages/schemas/src/index.test.ts`

**Interfaces:**
- Produces: package `@saral/schemas` exporting `CANONICAL_SCHEMA_VERSION: 1` and `RECEIPT_SPEC_VERSION: "KI-CR-v1.1.0"` (both `as const`).
- Produces: root scripts `lint`, `typecheck`, `test`, `build`, and `verify` (runs the four in order via `pnpm -r`). `tsconfig.base.json` (strict, `target` ES2022, `module` NodeNext) and `eslint.config.mjs` (typescript-eslint recommended) are shared by later workspaces.
- Produces: `packageManager` pinned to `pnpm@11.0.9`, `engines.node` `>=22.12`, workspaces `apps/*` and `packages/*`.

- [ ] **Step 0: Branch and save the plan.** `git switch -c chore/scaffold`, then commit this plan file (`docs: add repo scaffold plan`).
- [ ] **Step 1: Write the failing test** `packages/schemas/src/index.test.ts` with two tests: `canonical schema version starts at 1` (`expect(CANONICAL_SCHEMA_VERSION).toBe(1)`) and `receipt spec is Kantara KI-CR-v1.1.0` (`expect(RECEIPT_SPEC_VERSION).toBe("KI-CR-v1.1.0")`).
- [ ] **Step 2: Create the root and package config files** so the test can run (jest with `ts-jest`, `testEnvironment: node`). Run `pnpm install`. If pnpm blocks a dependency build script, run `pnpm approve-builds` and commit the resulting config. Run `pnpm --filter @saral/schemas test`. Expected: FAIL because `./index` has no exports.
- [ ] **Step 3: Implement** the two constants in `packages/schemas/src/index.ts`.
- [ ] **Step 4: Verify.** Run `pnpm verify`. Expected: lint, typecheck, test, build all exit 0 with 2 tests passing.
- [ ] **Step 5: Secret-file guard (Review Focus 1).**
  - `git check-ignore .env .env.local` prints both paths. `git check-ignore .env.example` exits 1 (not ignored).
  - `gitleaks detect --source . --no-git` exits 0.
  - Prove detection: write a throwaway file `/tmp/leak.txt` containing a fake AWS key line `aws_access_key_id = AKIAIOSFODNN7EXAMPLE` and `aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`, run `gitleaks detect --source /tmp --no-git`, expect exit 1, then delete the file. Nothing is committed.
- [ ] **Step 6: Commit** (`chore: add pnpm workspace, shared tooling, and schemas package`).

### Task 2: `packages/sdk-js` with a size budget

**Files:**
- Create: `packages/sdk-js/package.json` (`@saral/sdk-js`), `tsconfig.json`, `jest.config.cjs`, `tsup.config.ts`, `.size-limit.json`, `src/index.ts`
- Test: `packages/sdk-js/src/index.test.ts`

**Interfaces:**
- Produces: `export const version: string` from `src/index.ts`, injected at build time from `package.json` (tsup `define`) and read from `package.json` under Jest.
- Produces: build outputs `dist/saral-privacy.global.js` (IIFE, global name `SaralPrivacy`, minified), plus ESM and CJS. Script `size` runs `size-limit` with limit `25 kB` gzip on the IIFE file.

- [ ] **Step 1: Write the failing test** `sdk version matches package.json`: `expect(version).toBe(require("../package.json").version)`.
- [ ] **Step 2: Run** `pnpm --filter @saral/sdk-js test`. Expected: FAIL (no export).
- [ ] **Step 3: Implement** `version` and the tsup config described above.
- [ ] **Step 4: Run** `pnpm --filter @saral/sdk-js test`, `build`, and `size`. Expected: tests pass, file exists, size check passes.
- [ ] **Step 5: Budget guard (Review Focus 2).** Temporarily set the limit in `.size-limit.json` to `10 B`, run `pnpm --filter @saral/sdk-js size`. Expected: non-zero exit with a size error. Restore `25 kB` and re-run to confirm exit 0.
- [ ] **Step 6: Create** `packages/verifier/README.md` (one paragraph: open-source audit verifier, built in the audit-log plan; not a workspace yet). Commit (`feat: add sdk-js shell with 25 kB size budget`).

### Task 3: `apps/api` (NestJS)

**Files:**
- Create: `apps/api/package.json` (`@saral/api`), `tsconfig.json`, `jest.config.cjs`, `src/main.ts`, `src/app.module.ts`, `src/config.ts`, `src/health/health.controller.ts`, `Dockerfile`, `.dockerignore`
- Test: `apps/api/src/config.test.ts`, `apps/api/test/health.e2e.test.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): { port: number }`. Default port `4000`. Throws `Error` whose message contains `PORT` when the value is not an integer from 1 to 65535.
- Produces: `GET /healthz` returns HTTP 200 and `{"status":"ok"}`. It does not touch the database (liveness only).
- Produces: Docker image `saral-api:dev`, runs as a non-root user, `EXPOSE 4000`.

- [ ] **Step 1: Write failing tests.**
  - `config.test.ts`: `defaults port to 4000`, `reads PORT from env` (`{PORT:"4100"}` gives 4100), `rejects non-numeric PORT` (`{PORT:"abc"}` throws matching `/PORT/`), `rejects out-of-range PORT` (`"0"` and `"70000"` throw).
  - `health.e2e.test.ts`: boot the app with `@nestjs/testing` and `supertest`; `GET /healthz returns 200 and status ok`.
- [ ] **Step 2: Run** `pnpm --filter @saral/api test`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** config, controller, module, and `main.ts` (calls `loadConfig(process.env)`, listens on `config.port`, logs a clear error and exits with code 1 if config throws). Use the Nest packages directly rather than the Nest CLI generator.
- [ ] **Step 4: Run** `lint`, `typecheck`, `test`, and `build` for `@saral/api` with `pnpm --filter @saral/api run <script>`. Expected: all exit 0.
- [ ] **Step 5: Container check.** Multi-stage Dockerfile on `node:24-slim` using `pnpm deploy --prod`, build context is the repo root. Run `docker build -f apps/api/Dockerfile -t saral-api:dev .`, then `docker run -d --rm --name saral-api-smoke -p 4000:4000 saral-api:dev`, `curl -fsS localhost:4000/healthz` (expect `{"status":"ok"}`), `docker exec saral-api-smoke id -u` (expect non-zero), then `docker stop saral-api-smoke`. Also run `docker run --rm -e PORT=abc saral-api:dev` and expect a non-zero exit and a message naming `PORT` (Review Focus 3).
- [ ] **Step 6: Commit** (`feat: add NestJS api shell with healthz and validated config`).

### Task 4: `apps/ml` (FastAPI)

**Files:**
- Create: `apps/ml/pyproject.toml` (project `saral-ml`, `requires-python = ">=3.13"`, ruff config, pytest config), `apps/ml/.python-version` (`3.13`), `apps/ml/src/saral_ml/__init__.py`, `apps/ml/src/saral_ml/main.py`, `apps/ml/Dockerfile`, `apps/ml/.dockerignore`
- Test: `apps/ml/tests/test_health.py`

**Interfaces:**
- Produces: `saral_ml.main.app: FastAPI` with `GET /healthz` returning 200 and `{"status": "ok"}`.
- Produces: Docker image `saral-ml:dev` (python 3.13 slim, uv, non-root user, `EXPOSE 8000`).

- [ ] **Step 1: Write the failing test** `test_healthz_returns_ok` using `fastapi.testclient.TestClient`: status 200, JSON equals `{"status": "ok"}`.
- [ ] **Step 2: Run** `cd apps/ml && uv run pytest`. Expected: FAIL (`ModuleNotFoundError: saral_ml.main`).
- [ ] **Step 3: Implement** `main.py`.
- [ ] **Step 4: Run** `uv run pytest`, `uv run ruff check .`, `uv run ruff format --check .`. Expected: all exit 0. Commit `uv.lock`.
- [ ] **Step 5: Container check.** `docker build -t saral-ml:dev apps/ml`, run on port 8000, `curl -fsS localhost:8000/healthz`, stop it.
- [ ] **Step 6: Commit** (`feat: add FastAPI ml service shell`).

### Task 5: `apps/web` (Next.js dashboard shell)

**Files:**
- Create: `apps/web/` via `pnpm dlx create-next-app@latest apps/web` with TypeScript, Tailwind, ESLint, App Router, `src/` directory, import alias `@/*`, pnpm, no Turbopack flag needed. Then edit: `package.json` (name `@saral/web`, scripts `lint`, `typecheck` = `tsc --noEmit`, `test` = `jest`, `build`, `dev` on port 3000), add `jest.config.cjs` using `next/jest`, `src/app/page.tsx`
- Test: `apps/web/src/app/page.test.tsx`

**Interfaces:**
- Produces: home page rendering an `<h1>` with the exact text `Saral Privacy Dashboard`.

- [ ] **Step 1: Run the generator**, then delete generated boilerplate content and any generated lockfile or `.git` directory inside `apps/web`. Reconcile scripts to the convention above.
- [ ] **Step 2: Write the failing test** `home page renders the dashboard heading` with React Testing Library: `getByRole("heading", { name: "Saral Privacy Dashboard" })`.
- [ ] **Step 3: Run** `pnpm --filter @saral/web test`. Expected: FAIL (heading not found).
- [ ] **Step 4: Implement** `page.tsx`.
- [ ] **Step 5: Run** `pnpm --filter @saral/web lint`, `typecheck`, `test`, `build`. Expected: all exit 0.
- [ ] **Step 6: Commit** (`feat: add Next.js dashboard shell`).

### Task 6: `apps/wallet` and `apps/site`

**Files:**
- Create: `apps/wallet/` (`@saral/wallet`, port 3001, h1 `Saral DPDP Wallet`) and `apps/site/` (`@saral/site`, port 3002, h1 `Saral Privacy`), each following exactly the Task 5 recipe including the Jest config and a `page.test.tsx`.

**Interfaces:**
- Consumes: Task 5's recipe, scripts, and Jest config shape. Produces: two workspaces that pass the same four scripts.

- [ ] **Step 1: For each app,** repeat Task 5 steps 1 to 5 with its own name, port, and heading text (write the failing heading test first).
- [ ] **Step 2: Run** `pnpm verify` from the repo root. Expected: every workspace passes.
- [ ] **Step 3: Commit** (`feat: add wallet and site shells`).

### Task 7: Local PostgreSQL 16

**Files:**
- Create: `docker-compose.yml`, `.env.example`
- Modify: root `package.json` (scripts `db:up`, `db:down`, `db:psql`)

**Interfaces:**
- Produces: compose service `postgres` (`postgres:16`), user `saral`, password `saral_dev` (dev only, not a secret), database `saral`, port `5432`, named volume, healthcheck `pg_isready -U saral -d saral`.
- Produces: `.env.example` with `DATABASE_URL=postgres://saral:saral_dev@localhost:5432/saral` and the six service ports.

- [ ] **Step 1: Run** `docker compose config -q`. Expected: exit 0.
- [ ] **Step 2: Run** `pnpm db:up` (which is `docker compose up -d --wait postgres`). Expected: service healthy.
- [ ] **Step 3: Run** `docker compose exec postgres psql -U saral -d saral -tAc "show server_version"`. Expected: output starting with `16`.
- [ ] **Step 4: Run** `pnpm db:down`. Commit (`chore: add local postgres 16 compose stack`).

### Task 8: Terraform audit-anchor bucket and environment stacks

**Files:**
- Create: `infra/terraform/modules/audit_anchor_bucket/{main.tf,variables.tf,outputs.tf,versions.tf}`
- Test: `infra/terraform/modules/audit_anchor_bucket/tests/object_lock.tftest.hcl`
- Create: `infra/terraform/envs/{dev,staging,prod}/{main.tf,variables.tf,versions.tf,backend.tf}` and `infra/terraform/envs/backend.hcl.example`

**Interfaces:**
- Produces: module inputs `environment` (string, must be one of `dev`, `staging`, `prod`), `bucket_name` (string), `retention_years` (number, default `7`, must be at least `1`). Outputs `bucket_id`, `bucket_arn`, `object_lock_mode` (`"COMPLIANCE"` when `environment == "prod"`, else `"GOVERNANCE"`).
- Produces: resources `aws_s3_bucket` with `object_lock_enabled = true`, `aws_s3_bucket_versioning` (Enabled), `aws_s3_bucket_public_access_block` (all four flags true), `aws_s3_bucket_server_side_encryption_configuration` (AES256 for now; KMS key arrives with the KMS module), `aws_s3_bucket_object_lock_configuration` with `default_retention` mode and `years = var.retention_years`.
- Env stacks: provider region `ap-south-1`, partial `backend "s3" {}` (values supplied by `-backend-config`), module call with `environment` fixed per directory, `bucket_name` as a required variable. AWS provider pinned to the current major of `hashicorp/aws` (verify in the registry), `required_version >= 1.9`.

- [ ] **Step 1: Write the failing tests** in `object_lock.tftest.hcl` using `mock_provider "aws" {}` and `command = plan`:
  - `prod_uses_compliance_mode_for_seven_years`: `environment = "prod"`, assert `aws_s3_bucket_object_lock_configuration.this.rule[0].default_retention[0].mode == "COMPLIANCE"` and `.years == 7`.
  - `dev_uses_governance_mode` and `staging_uses_governance_mode`: assert `"GOVERNANCE"`.
  - `unknown_environment_is_rejected`: `environment = "qa"`, `expect_failures = [var.environment]`.
  - `zero_retention_is_rejected`: `retention_years = 0`, `expect_failures = [var.retention_years]` (Review Focus 4).
- [ ] **Step 2: Run** `cd infra/terraform/modules/audit_anchor_bucket && terraform init -backend=false && terraform test`. Expected: FAIL (resources and variables undefined).
- [ ] **Step 3: Implement** the module per the Interfaces block.
- [ ] **Step 4: Run** `terraform test`. Expected: all tests pass.
- [ ] **Step 5: Implement the three env stacks,** then for each directory run `terraform init -backend=false && terraform validate`. Expected: `Success! The configuration is valid.` Run `terraform fmt -check -recursive infra/terraform`. Expected: exit 0.
- [ ] **Step 6: Commit** (`feat: add audit anchor bucket module and env stacks`).

### Task 9: Docs, ADR, and contribution rules

**Files:**
- Create: `docs/adr/0000-template.md`, `docs/adr/0001-toolchain-and-versions.md`, `docs/threat-model/README.md`, `docs/compliance/traceability.md`, `CONTRIBUTING.md`, `SECURITY.md`, `.github/pull_request_template.md`, `.github/CODEOWNERS`
- Modify: `README.md` (add "Getting started": prerequisites, `pnpm install`, `pnpm verify`, `pnpm db:up`, ports), `docs/PLAN.md` (D4 row and section 5.1: replace "Next.js 14" with "Next.js, current supported major (14 is end of life)")

**Interfaces:**
- ADR-0001 records: Next.js version deviation from D4, Node 24 with `>=22.12` engines, pnpm, Jest, uv with Python 3.13, IIFE instead of UMD, Terraform native tests, audit bucket stack in this scaffold and KMS/RDS/ECS deferred.
- `docs/compliance/traceability.md` is a table with columns `Rule (as cited) | Requirement | Feature | Test IDs | Status`, seeded with the six rows from `docs/PLAN.md` section 7 and Status `not started`.
- `CONTRIBUTING.md` holds the Definition of Done from `docs/PLAN.md` section 6.1, trunk-based rules, and the note that branch protection is by convention (it is not configured by this plan).
- `.github/CODEOWNERS`: `* @pranaav2k5`.

- [ ] **Step 1: Write the files.**
- [ ] **Step 2: Verify the PLAN edit.** `git grep -n "Next.js 14" docs/PLAN.md` returns only the "(14 is end of life)" mention.
- [ ] **Step 3: Verify the README commands** by running `pnpm install --frozen-lockfile && pnpm verify` from a fresh clone in a temp directory (`git clone . /tmp/saral-fresh`). Expected: exit 0. Delete the temp directory.
- [ ] **Step 4: Commit** (`docs: add ADR, traceability matrix, and contribution rules`).

### Task 10: CI workflow and pull request

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Workflow `ci` runs on `pull_request` and on `push` to `main`, with top-level `permissions: contents: read` and `concurrency` cancelling superseded runs. Jobs:
  - `node`: matrix Node `22` and `24`. Steps: checkout, `pnpm/action-setup`, `actions/setup-node` with pnpm cache, `pnpm install --frozen-lockfile`, `pnpm verify`, `pnpm --filter @saral/sdk-js size`.
  - `python`: `astral-sh/setup-uv`, in `apps/ml`: `uv sync --locked`, `uv run ruff check .`, `uv run ruff format --check .`, `uv run pytest`.
  - `terraform`: `hashicorp/setup-terraform`, `terraform fmt -check -recursive infra/terraform`, module `terraform test`, `init -backend=false` plus `validate` for each env, then `bridgecrewio/checkov-action` on `infra/terraform`.
  - `security`: `gitleaks/gitleaks-action` (full history) and `aquasecurity/trivy-action` in `fs` mode, severity `HIGH,CRITICAL`, `exit-code: 1`.
- Every third-party action is pinned to a full commit SHA with the tag in a trailing comment.

- [ ] **Step 1: Resolve SHAs.** For each action, `gh api repos/<owner>/<repo>/git/ref/tags/<tag> --jq .object.sha` (follow tag objects to the commit if the type is `tag`). Write the workflow using those SHAs.
- [ ] **Step 2: Lint the workflow.** `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest`. Expected: no output, exit 0.
- [ ] **Step 3: Push the branch and open a pull request** with `gh pr create --base main --head chore/scaffold --title "chore: scaffold monorepo"`, body summarizing the tasks and the Next.js and Node deviations.
- [ ] **Step 4: Watch CI.** `gh pr checks --watch`. Expected: all jobs green on both Node 22 and 24. If Checkov or Trivy report real findings in scaffold code, fix the code or add a documented, narrowly scoped suppression with a reason; do not weaken the severity gate.
- [ ] **Step 5: Stop with the pull request open.** Merging is the owner's action. Report the PR URL and the CI result.

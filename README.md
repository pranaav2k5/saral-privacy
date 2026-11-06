# Saral Privacy

A DPDP-native consent and privacy operations platform for Indian small and mid-sized businesses. Notice generation in Indian languages, consent capture with signed receipts, data-principal rights handling, records of processing, breach workflow, and a tamper-evident audit log.

Status: **early build**. The plan is approved (its open decisions are still to be answered). Built and tested so far: the canonical string contract, the audit hash chain with Merkle anchors, signed consent receipts with a JWKS, and the free notice generator at `/notice-generator` in `apps/site` (English and Hindi drafts, pending legal and native-speaker review). The database schema with row-level security and the consent API (grant, withdraw, receipt, JWKS, audit verification; contract in `docs/design/openapi.yaml`) are built too. Signed, retried webhooks and the browser consent SDK (`packages/sdk-js`, 6 kB gzipped) are built too. Data-principal rights requests (queue, state machine, erasure) are built too. Staff login with MFA (password, authenticator code, recovery codes, sessions) is built too. The staff dashboard (`apps/web`: sign-in with MFA, overview, the rights-request queue, audit verification and webhook integrations) is built too. An operator command-line tool makes organisations and staff accounts, recovers them, sets each organisation's receipt profile and issues, lists and revokes API keys (`pnpm --filter @saral/api operator`, development key provider only). Notices can be published and listed through the API (`POST` and `GET /v1/notices`, threat model 0010). Not built yet: the dashboard screens for notice publishing, key management and consent search, self-service password change, the nightly anchor job, KMS adapters and deployment. See `docs/PLAN.md` for the schedule.

Read `docs/design/HLD.md` for the architecture and `docs/design/openapi.yaml` for the API.

Key date: the Digital Personal Data Protection Act's full compliance deadline is **13 May 2027**.

## Read in this order

1. [`docs/PLAN.md`](docs/PLAN.md): the master plan. Scope, reconciled decisions, architecture, 16-week calendar, go-to-market, risks, roadmap, open decisions.
2. [`docs/RESEARCH.md`](docs/RESEARCH.md): what was verified, what was found wrong in the source documents, and what is still unverified.
3. [`docs/design/HLD.md`](docs/design/HLD.md) and [`docs/design/LLD.md`](docs/design/LLD.md): the architecture and the module detail as built, plus the designed-but-unbuilt parts. [`docs/design/openapi.yaml`](docs/design/openapi.yaml) is the API contract.

## Getting started

Prerequisites: Node 24 LTS (22.12 or newer works), pnpm 11, Python 3.13 with uv, Terraform 1.10 or newer, Docker.

```
pnpm install
pnpm verify          # lint, typecheck, test, build for every TypeScript workspace
pnpm db:up           # local PostgreSQL 16 on 127.0.0.1:5432 (pnpm db:down to stop)
cd apps/ml && uv sync && uv run pytest
```

Local ports: web 3000, wallet 3001, site 3002, api 4000, ml 8000, postgres 5432. See `CONTRIBUTING.md` for the workflow and Definition of Done.

## Layout

- `apps/api`: NestJS control plane. `apps/ml`: FastAPI ML service.
- `apps/web`, `apps/wallet`, `apps/site`: Next.js staff dashboard (built), consumer wallet (a shell), and marketing site with the free notice tool.
- `packages/schemas`: versioned schema constants and the frozen canonical strings. `packages/audit-chain`: hash chain, Merkle tree, anchors. `packages/receipts`: Kantara consent receipts as signed JWTs. `packages/notice`: privacy notice engine. `packages/sdk-js`: browser consent SDK (25 kB gzipped budget). `packages/verifier`: command-line verifier, README only for now.
- `infra/terraform`: AWS modules and environment stacks.
- `docs/`: plan, research log, ADRs, threat models, compliance matrix.

## Source material

The plan merges two documents that are not stored in this repository:

- Saral Privacy Strategy Report (PDF, May 2026)
- Saral Privacy + Consumer Data Layer: Technical Feasibility and SDLC Plan (Markdown, May 2026)

## Not legal advice

Nothing in this repository is legal advice. Rule citations must be checked against the Gazette text by a qualified lawyer before use.

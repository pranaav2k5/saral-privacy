# Spine and Free Notice Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the P0 MVP of `docs/PLAN.md` and its design documents: the frozen canonical-string contract, the tamper-evident audit chain with Merkle anchoring, signed consent receipts with a JWKS, the free Notice Generator (English and Hindi), the database schema with row-level security, the consent API, webhooks, the browser SDK, data-principal rights, staff authentication with MFA, the dashboard, and the HLD, LLD and OpenAPI documents.

**Architecture:** Pure, dependency-light TypeScript packages hold the contracts and cryptography (`@saral/schemas`, `@saral/audit-chain`, `@saral/receipts`, `@saral/notice`). Nothing in them touches a database or a cloud API, so each is testable in isolation and can be reused by the API, the verifier, and the SDK. The database task adds SQL migrations and tests them against a real PostgreSQL 16. The notice tool runs entirely in the browser, because the site holds no personal data (decision D5).

**Tech Stack:** TypeScript 6, Jest with ts-jest, Node `crypto`, `jose` only if it loads under the CJS Jest setup, Next.js 16, PostgreSQL 16 with `pg`.

**Spec:** `docs/PLAN.md` (sections 4, 5.2, 6) and `docs/RESEARCH.md`. Decisions D2, D5, D7, D9, D10, D11, D12 and D16 bind this plan.

## Global Constraints

- The repository is public. Never commit secrets, private keys, AWS account IDs, real personal data, or customer details. Tests generate keys at runtime. Fixtures use obviously fake values (`example.org`, `.invalid` domains, `+91 00000 00000`-style numbers, UUIDs made up for tests).
- Every commit has author AND committer `pranaav2k5` (`143247213+pranaav2k5@users.noreply.github.com`) and no `Co-authored-by` trailer. Before every push run `git log --format='%an|%cn' origin/main..HEAD | sort | uniq -c` and confirm only `pranaav2k5|pranaav2k5` appears.
- Branches form one stack. Each branch starts from the previous task's branch. Each pull request's base is the previous branch (the first is `main`). Nothing is merged by the implementer.
- Commit subjects use a type prefix (`feat:`, `fix:`, `chore:`, `docs:`, `test:`). The failing test is written first and watched failing.
- Node `>=22.12`. CI runs Node 22 and 24. TypeScript 6.0.x. New workspace packages copy the layout of `packages/schemas` (CJS output, `jest.config.cjs`, `tsconfig.json`, `tsconfig.build.json`).
- The canonical string schema version is 1 and is frozen after Task 2. Changing a v1 output means bumping the version, never editing v1.
- HMAC keys and signing keys are always passed in by the caller. No package reads keys from the environment or the filesystem.
- Nothing in code, copy or docs claims legal compliance. Notice text says it is a draft that needs review by the customer's counsel. Hindi output carries the "pending human review" mark (decision D9).
- Rule numbers are cited as in `docs/PLAN.md` section 7 and are marked as unverified against the Gazette.
- Definition of Done per `CONTRIBUTING.md`: tests, threat-model checkbox (and a model file for epics of 5 points or more), RoPA-impact check, traceability matrix updated.

## Review Focus

1. **Canonical ambiguity.** Two different records must never produce the same canonical string. Values containing `|`, quotes, backslashes, newlines, NUL and non-ASCII must round-trip unambiguously. Tested in Task 2.
2. **Silent truncation.** Deleting the newest rows leaves a valid chain. Only an anchor (head hash, count, Merkle root) can catch it, so verification against an anchor must fail when rows are missing at the tail. Tested in Task 3.
3. **Merkle second-preimage and duplicate-leaf.** `[a,b,c]` and `[a,b,c,c]` must have different roots, and an inner node must not verify as a leaf. Tested in Task 3.
4. **JWT algorithm confusion.** `alg: none`, `HS256` signed with the public key bytes, an unknown `kid`, a missing `kid`, a tampered payload and an RSA key under 2048 bits must all be rejected. Tested in Task 4.
5. **Row-level security bypass.** A superuser or the table owner skips RLS. With `app.tenant_id` unset the app role must see zero rows, and inserts for another tenant must be refused. Tested in Task 7.
6. **Notice input injection.** Organisation names with HTML, `{{` or Markdown must be shown as text, never executed, and the notice hash must not depend on line endings or Unicode normalisation form. Tested in Tasks 5 and 6.

---

### Task 1: Public-repo hygiene (branch `chore/public-repo-hygiene`, base `main`)

**Files:**
- Modify: `.gitignore`, `SECURITY.md`, `CONTRIBUTING.md`, `docs/adr/0001-toolchain-and-versions.md` is not touched.
- Create: `docs/superpowers/plans/2026-11-06-spine-and-notice-tool.md` (this file).

**Interfaces:**
- Produces: a `.gitignore` that excludes `infra/terraform/envs/backend.hcl`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.kdbx`, `id_rsa*`, `.aws/`, `*.tfplan` and `tfplan`.

- [ ] **Step 1: Write the check.** Run `git check-ignore -v infra/terraform/envs/backend.hcl signing.pem x.key plan.tfplan`. Expected: exit 1, nothing ignored (this is the failing state).
- [ ] **Step 2: Edit `.gitignore`** with the entries above under a "secrets and key material" heading. Rerun the check. Expected: all four paths reported as ignored.
- [ ] **Step 3: Update `SECURITY.md`** to state that GitHub private vulnerability reporting is enabled (it was enabled on 2026-11-06 and verified through the API) and that secret scanning with push protection is on. Update `CONTRIBUTING.md` with a "Commit identity" line and a "public repository" rule (no secrets, no real personal data, no customer names in issues or PRs).
- [ ] **Step 4: Verify.** `pnpm verify` exits 0 and `gitleaks git . --no-banner` reports no leaks.
- [ ] **Step 5: Commit** the plan file and the hygiene changes as two commits, push, open a PR with base `main`.

### Task 2: Canonical string v1 (branch `feat/canonical-schema`, base `chore/public-repo-hygiene`)

**Files:**
- Create: `packages/schemas/src/canonical.ts`, `packages/schemas/src/canonical.test.ts`, `docs/adr/0002-canonical-string-v1.md`
- Modify: `packages/schemas/src/index.ts` (re-export), `docs/compliance/traceability.md`

**Interfaces:**
- Produces (all exported from `@saral/schemas`):
  - `type ActorType = "principal" | "dpo" | "system"`
  - `interface AuditFields { tenantId: string; seqNo: string; ts: string; actorType: ActorType; actorId: string | null; action: string; refTable: string; refId: string; payloadSha256: string }`
  - `type PurposeGrant = { key: string; granted: boolean; retentionDays: number }`
  - `interface ConsentFields { tenantId: string; consentId: string; principalId: string; noticeId: string; noticeSha256: string; purposes: PurposeGrant[]; status: "granted" | "withdrawn" | "expired"; grantedAt: string; withdrawnAt: string | null; collectionMethod: "web_sdk" | "api" | "dpo_entry" }`
  - `class CanonicalError extends Error`
  - `function canonicalAuditEntry(fields: AuditFields, version?: number): string`
  - `function canonicalConsentRecord(fields: ConsentFields, version?: number): string`
  - `const SUPPORTED_CANONICAL_VERSIONS: readonly number[]` (is `[1]`)
- Format v1: `JSON.stringify` of a fixed-order array. Audit: `["saral.audit", 1, tenantId, seqNo, ts, actorType, actorId, action, refTable, refId, payloadSha256]`. Consent: `["saral.consent", 1, tenantId, consentId, principalId, noticeId, noticeSha256, purposes, status, grantedAt, withdrawnAt, collectionMethod]` where `purposes` is an array of `[key, granted, retentionDays]` sorted by key in plain code-unit order.
- Validation (throws `CanonicalError` naming the field): UUIDs lowercase RFC 4122 form; `seqNo` matches `^(0|[1-9][0-9]{0,18})$` (a string, because it is a bigint); timestamps match `YYYY-MM-DDTHH:mm:ss.sssZ` and parse to the same instant; `payloadSha256` and `noticeSha256` are 64 lowercase hex; `action` matches `^[a-z]+(\.[a-z_]+)+$`; `refTable` matches `^[a-z_]+$`; `actorId` is null or 1 to 128 characters; purpose keys match `^[a-z][a-z0-9_]{0,62}$`, are unique, and there is at least one; `retentionDays` is an integer from 0 to 36500; `withdrawnAt` is non-null exactly when `status` is `withdrawn`; an unsupported `version` throws.
- Decision recorded in the ADR: `payloadSha256` is an addition to the column list in `docs/PLAN.md` section 5.2. It binds each audit entry to the content of the record it refers to (the SHA-256 of `canonicalConsentRecord(...)` for consents). Cost if wrong: one extra column, and v1 has no stored data yet.

- [ ] **Step 1: Write failing tests** in `canonical.test.ts`: golden vector for a fixed audit entry and a fixed consent record (the exact expected strings are pinned in the test and are the freeze); purposes given in any order yield the same string; a value containing `|`, `"`, `\`, a newline, NUL and `é` yields a string that `JSON.parse` turns back into the same array (ambiguity test); two records differing only by a delimiter-laden field give different strings; each validation rule above rejects one bad input; `version: 2` throws; withdrawn without `withdrawnAt` throws; `SUPPORTED_CANONICAL_VERSIONS` equals `[1]` (this test fails loudly if someone bumps it without adding vectors).
- [ ] **Step 2: Run** `pnpm --filter @saral/schemas test`. Expected: FAIL, cannot find `./canonical`.
- [ ] **Step 3: Implement** `canonical.ts` with small validators and the two builders. No dependencies, no `crypto`.
- [ ] **Step 4: Run** `pnpm --filter @saral/schemas test`. Expected: all pass, coverage of every validation branch.
- [ ] **Step 5: Write `docs/adr/0002-canonical-string-v1.md`** (status accepted; format, field order, the `payloadSha256` addition, the freeze rule, how to bump). Tick the Rule 6 audit row in `docs/compliance/traceability.md` to "canonical contract built; chain in Task 3".
- [ ] **Step 6: Run** `pnpm verify`, commit, push, open a PR with base `chore/public-repo-hygiene`.

### Task 3: Audit chain, Merkle anchoring and verifier core (branch `feat/audit-chain`, base `feat/canonical-schema`)

**Files:**
- Create: `packages/audit-chain/{package.json,jest.config.cjs,tsconfig.json,tsconfig.build.json}`, `packages/audit-chain/src/{hash.ts,chain.ts,merkle.ts,anchor.ts,index.ts}` with one `*.test.ts` each, `docs/threat-model/0001-audit-log.md`
- Modify: `packages/verifier/README.md` (point to `@saral/audit-chain`), `docs/compliance/traceability.md`

**Interfaces:**
- Consumes: `AuditFields`, `canonicalAuditEntry`, `SUPPORTED_CANONICAL_VERSIONS` from `@saral/schemas`.
- Produces (from `@saral/audit-chain`):
  - `const GENESIS_HASH: string` (64 zeros)
  - `function sha256Hex(data: string | Uint8Array): string`
  - `function entryHash(key: Uint8Array, prevHash: string, canonical: string): string` — HMAC-SHA256 over `prevHash || canonical` (UTF-8), lowercase hex. Key shorter than 32 bytes throws.
  - `interface ChainEntry extends AuditFields { prevHash: string; entryHash: string; canonicalSchemaVersion: number; hmacSchemaVersion: number }`
  - `type KeyResolver = (hmacSchemaVersion: number) => Uint8Array | undefined`
  - `function sealEntry(fields: AuditFields, prevHash: string, key: Uint8Array, opts?: { canonicalSchemaVersion?: number; hmacSchemaVersion?: number }): ChainEntry`
  - `type ChainFailure = "hash_mismatch" | "prev_mismatch" | "seq_gap" | "unknown_key" | "unsupported_version" | "invalid_fields" | "tenant_mismatch"`
  - `type ChainResult = { ok: true; count: number; headHash: string; lastSeqNo: string | null } | { ok: false; failure: ChainFailure; seqNo: string }`
  - `function verifyChain(entries: readonly ChainEntry[], resolveKey: KeyResolver, opts?: { startPrevHash?: string; startSeqNo?: string }): ChainResult` — entries must be in `seqNo` order, share one tenant, and have contiguous `seqNo` (compare with `BigInt`). The first entry's `prevHash` must equal `startPrevHash` (default `GENESIS_HASH`). Hash comparison is constant-time.
  - `function merkleRoot(leafHashes: readonly string[]): string` — RFC 6962: leaf = SHA-256(0x00 ‖ 32 raw bytes of the entry hash), node = SHA-256(0x01 ‖ left ‖ right), split at the largest power of two below n, empty tree = SHA-256 of the empty string.
  - `function merkleProof(leafHashes: readonly string[], index: number): string[]` and `function verifyMerkleProof(root: string, leafHash: string, index: number, size: number, proof: readonly string[]): boolean`
  - `interface Anchor { version: 1; tenantId: string; date: string; count: number; firstSeqNo: string; lastSeqNo: string; headHash: string; merkleRoot: string }`
  - `function buildAnchor(tenantId: string, date: string, entries: readonly ChainEntry[]): Anchor` (throws on an empty list)
  - `function anchorBody(anchor: Anchor): string` — canonical JSON with fixed key order, newline terminated, the exact bytes that go to S3.
  - `function verifyAgainstAnchor(entries: readonly ChainEntry[], anchor: Anchor, resolveKey: KeyResolver, opts?: { startPrevHash?: string }): ChainResult | { ok: false; failure: "anchor_mismatch"; seqNo: string }` — runs `verifyChain`, then checks count, first and last `seqNo`, head hash and Merkle root.

- [ ] **Step 1: Write failing tests**, one file per module. `hash`: HMAC known-answer vector from RFC 4231 test case 2 truncated-key rule is not used (keys must be at least 32 bytes), so use a fixed 32-byte test key and a pinned expected hex; wrong key length throws. `merkle`: empty root, single leaf, three leaves, `[a,b,c]` root differs from `[a,b,c,c]`, a leaf hash and an inner node with equal bytes do not verify as each other, proofs verify for every index for sizes 1 to 17, a proof with one flipped bit fails, wrong index fails. `chain`: a 5-entry chain verifies; editing any one field of any one entry reports that entry's `seqNo` with `hash_mismatch`; deleting a middle entry reports `seq_gap`; swapping two entries is rejected; inserting a forged entry with a recomputed hash under a wrong key reports `hash_mismatch`; mixed tenants report `tenant_mismatch`; an entry with `hmacSchemaVersion` the resolver does not know reports `unknown_key`; `canonicalSchemaVersion: 2` reports `unsupported_version`; a continuation segment verifies with `startPrevHash`. `anchor`: a clean list verifies; dropping the last entry fails with `anchor_mismatch` while `verifyChain` alone still says ok (the truncation test, Review Focus 2); `anchorBody` is byte-stable against a pinned string.
- [ ] **Step 2: Run** `pnpm --filter @saral/audit-chain test`. Expected: FAIL, modules missing.
- [ ] **Step 3: Implement** the modules with Node `crypto` only (`createHmac`, `createHash`, `timingSafeEqual`).
- [ ] **Step 4: Run** the package tests. Expected: all pass. Run `pnpm --filter @saral/audit-chain test -- --coverage` and confirm at least 90 percent line coverage on `chain.ts` and `merkle.ts`.
- [ ] **Step 5: Write `docs/threat-model/0001-audit-log.md`** in the template from `docs/threat-model/README.md`: STRIDE rows for key compromise (mitigation: anchor in Object Lock, key in KMS), truncation, reordering, replay of an old anchor, and erasure versus immutability. Each row names the test that proves it or the later task that will. Update the traceability rows for Rule 6(1)(e) and 8(3).
- [ ] **Step 6: Run** `pnpm verify`, commit, push, open a PR with base `feat/canonical-schema`.

### Task 4: Consent receipts and JWKS (branch `feat/consent-receipts`, base `feat/audit-chain`)

**Files:**
- Create: `packages/receipts/{package.json,jest.config.cjs,tsconfig.json,tsconfig.build.json}`, `packages/receipts/src/{claims.ts,jwt.ts,jwks.ts,local-signer.ts,index.ts}` with tests, `docs/threat-model/0002-consent-receipt.md`
- Modify: `docs/RESEARCH.md` (record the verified Kantara field list), `docs/compliance/traceability.md`

**Interfaces:**
- Consumes: `RECEIPT_SPEC_VERSION` from `@saral/schemas`.
- Produces (from `@saral/receipts`):
  - `interface KantaraReceiptClaims` with the REQUIRED fields of KI-CR-v1.1.0 (`version`, `jurisdiction`, `consentTimestamp`, `collectionMethod`, `consentReceiptID` as a UUID v4, `language`, `piiPrincipalId`, `piiControllers`, `policyUrl`, `services` with `purposes`, `sensitive`, `spiCat`) plus `iat`. The exact required set is confirmed against the specification text in Step 1 and recorded in `docs/RESEARCH.md`.
  - `function buildReceiptClaims(input: ReceiptInput, now?: Date): KantaraReceiptClaims` where `ReceiptInput` carries the controller, the principal pseudonym, notice URL, per-purpose grants and a receipt id. It rejects non-HTTPS `policyUrl`, a non-v4 receipt id and an empty purpose list.
  - `interface ReceiptSigner { readonly kid: string; sign(signingInput: Uint8Array): Promise<Uint8Array> }` — an RS256 (RSASSA-PKCS1-v1_5 with SHA-256) signature over the input. A later KMS adapter implements the same interface.
  - `function createLocalSigner(opts?: { modulusLength?: 2048 | 3072 }): Promise<{ signer: ReceiptSigner; publicJwk: JsonWebKey & { kid: string; alg: "RS256"; use: "sig" } }>` — for development and tests only; the key lives in memory.
  - `function signReceipt(claims: KantaraReceiptClaims, signer: ReceiptSigner): Promise<string>` — compact JWS with header `{ alg: "RS256", typ: "JWT", kid }`.
  - `function buildJwks(keys: readonly JwkPublic[]): { keys: JwkPublic[] }`
  - `function verifyReceipt(jwt: string, jwks: { keys: readonly JwkPublic[] }): Promise<KantaraReceiptClaims>` — throws `ReceiptVerificationError` with a `code` of `malformed`, `bad_alg`, `unknown_kid`, `weak_key`, `bad_signature` or `bad_claims`.

- [ ] **Step 1: Confirm the Kantara field list** with a web search for the KI-CR-v1.1.0 specification and write the result into `docs/RESEARCH.md` with the source URL. If the sources disagree, follow the specification PDF and record the conflict.
- [ ] **Step 2: Write failing tests.** Round trip: build, sign, verify returns equal claims. Rejections: payload tampered after signing (`bad_signature`); `alg: none` token (`bad_alg`); HS256 token whose HMAC key is the public key bytes (`bad_alg`); unknown `kid` and missing `kid` (`unknown_kid`); a JWKS whose key is under 2048 bits (`weak_key`); three-part token with a non-base64url segment (`malformed`); claims missing a required field (`bad_claims`). `buildJwks` output contains no private members (`d`, `p`, `q`, `dp`, `dq`, `qi`) and the test fails if any appears. `kid` is stable for the same key.
- [ ] **Step 3: Run** `pnpm --filter @saral/receipts test`. Expected: FAIL, modules missing.
- [ ] **Step 4: Implement.** Try `jose` first (`pnpm --filter @saral/receipts add jose`). If it does not load under ts-jest CJS, implement with Node `crypto` and a strict verifier that accepts only `RS256`, requires a `kid`, and checks the key size before verifying. Record the choice as a ruling in the ledger.
- [ ] **Step 5: Run** the package tests, then write `docs/threat-model/0002-consent-receipt.md` (spoofed receipts, key rotation, JWKS cache poisoning, replay, PII in receipts: only a pseudonymous principal id). Update the traceability matrix.
- [ ] **Step 6: Run** `pnpm verify`, commit, push, open a PR with base `feat/audit-chain`.

### Task 5: Notice engine (branch `feat/notice-generator`, base `feat/consent-receipts`)

**Files:**
- Create: `packages/notice/{package.json,jest.config.cjs,tsconfig.json,tsconfig.build.json}`, `packages/notice/src/{input.ts,render.ts,templates/en.ts,templates/hi.ts,hash.ts,index.ts}` with tests, `docs/compliance/notice-template-review.md`
- Modify: `docs/compliance/traceability.md`

**Interfaces:**
- Produces (from `@saral/notice`):
  - `type NoticeLanguage = "en" | "hi"`
  - `interface NoticePurpose { name: string; description: string; dataItems: string[]; retention: string }`
  - `interface NoticeInput { organisationName: string; websiteUrl: string; grievanceEmail: string; grievanceAddress: string; dpoName: string; purposes: NoticePurpose[]; thirdParties: string[]; processesChildrenData: boolean; withdrawalUrl: string; rightsRequestUrl: string }`
  - `type FieldError = { field: string; message: string }`
  - `function validateNoticeInput(raw: unknown): { ok: true; value: NoticeInput } | { ok: false; errors: FieldError[] }` — trims strings; requires `https` URLs; requires an email-shaped `grievanceEmail`; requires at least one purpose with at least one data item; caps lengths (name 200, description 1000, at most 30 purposes and 50 items each); rejects control characters.
  - `interface RenderedNotice { language: NoticeLanguage; reviewStatus: "pending-human-review"; title: string; sections: { heading: string; body: string[] }[]; text: string }`
  - `function renderNotice(input: NoticeInput, language: NoticeLanguage): RenderedNotice`
  - `function canonicalNoticeText(text: string): string` — Unicode NFC, `\r\n` and `\r` to `\n`, trailing spaces trimmed per line, single trailing newline.
  - `function noticeSha256(text: string): Promise<string>` — Web Crypto digest of the canonical text, lowercase hex.
- Sections in both languages, in this order: who we are, what personal data we process and why (one entry per purpose with data items, the goods or services or uses it enables, and the retention period), who we share it with, your rights and how to use them (link), how to withdraw consent (link, stated to be as easy as giving it), children, how to complain (the organisation's grievance contact first, then the Data Protection Board of India), a "draft, not legal advice" footer. The Rule 3 elements are cited as "Rule 3, unverified against the Gazette" in `docs/compliance/notice-template-review.md`, which also lists every template string a lawyer must review and records that Hindi is pending human review (D9, D16).
- The processes-children section changes with `processesChildrenData` (true adds a line that verifiable parental consent applies, per the traceability matrix row for Rule 10).

- [ ] **Step 1: Write failing tests.** Validation: each rule above rejects one bad input and a good input passes. Rendering: the English notice for a pinned input contains every section heading in order and every purpose, data item and retention string; the Hindi notice contains the Devanagari headings and the same input values; both have `reviewStatus` `pending-human-review`; `processesChildrenData` toggles the children line; `thirdParties: []` renders a "we do not share" sentence rather than an empty list. Injection: an organisation name of `<img src=x onerror=alert(1)>` or `{{x}}` or `**bold**` appears verbatim in `text` and no template placeholder is expanded twice. Hash: the same text with CRLF endings, with trailing spaces, and in NFD form hashes identically to the canonical form; a one-character change in a purpose changes the hash; a pinned input yields a pinned hash (stability across versions).
- [ ] **Step 2: Run** `pnpm --filter @saral/notice test`. Expected: FAIL, modules missing.
- [ ] **Step 3: Implement** with plain string templates (no template engine, no `eval`). Hindi strings are written by hand in `templates/hi.ts` and are marked as drafts.
- [ ] **Step 4: Run** the package tests. Expected: all pass.
- [ ] **Step 5: Write `docs/compliance/notice-template-review.md`** and update the Rule 3 row of the traceability matrix to "engine built, templates draft, legal review pending".
- [ ] **Step 6: Run** `pnpm verify`, commit. Do not push yet: Task 6 shares this branch and PR.

### Task 6: Free Notice Generator page (same branch `feat/notice-generator`)

**Files:**
- Create: `apps/site/src/app/notice-generator/page.tsx`, `apps/site/src/app/notice-generator/notice-form.tsx`, `apps/site/src/app/notice-generator/notice-form.test.tsx`
- Modify: `apps/site/src/app/page.tsx` (link to the tool), `apps/site/package.json` (depends on `@saral/notice`; add `@testing-library/react` and `@testing-library/jest-dom` if absent), `README.md` (status line)

**Interfaces:**
- Consumes: `validateNoticeInput`, `renderNotice`, `noticeSha256`, `NoticeLanguage`, `RenderedNotice` from `@saral/notice`.
- Produces: the route `/notice-generator`. A client component form collects the `NoticeInput` fields (purposes as a repeatable group), a language selector (English, Hindi), shows field errors, renders the notice as text (never as HTML), shows the SHA-256, and offers "Copy" and "Download .txt". A visible banner says "Draft for your lawyer to review. Not legal advice." and, for Hindi, "Beta, pending human review". The page makes no network request and stores nothing (no cookies, no local storage, no analytics).

- [ ] **Step 1: Write failing tests** in `notice-form.test.tsx`: submitting an empty form shows an error for each required field and no notice; a filled form shows the notice, a 64-hex hash and the draft banner; switching to Hindi shows the "pending human review" banner and Devanagari text; an organisation name containing `<b>x</b>` is shown as literal text (query by text, assert no `b` element is created); no `fetch` call is made during the flow (spy on `global.fetch`); the Download link uses a `Blob` of the rendered text.
- [ ] **Step 2: Run** `pnpm --filter @saral/site test`. Expected: FAIL, route missing.
- [ ] **Step 3: Implement** the page and form. Keep the existing heading test on the home page passing.
- [ ] **Step 4: Run** `pnpm --filter @saral/site test` then `pnpm verify`. Then start the dev server, load `/notice-generator` with a real browser request (`curl` for the HTML and the page's built JS), and fill nothing in manually: record in the ledger that the page returned HTTP 200 and that `pnpm --filter @saral/site build` succeeds.
- [ ] **Step 5: Push** the branch and open a PR with base `feat/consent-receipts`.

### Task 7: Database schema and row-level security (branch `feat/db-schema-rls`, base `feat/notice-generator`)

**Files:**
- Create: `apps/api/db/migrations/0001_core.sql`, `apps/api/db/migrations/0002_audit_log.sql`, `apps/api/src/db/migrate.ts`, `apps/api/test/db/rls.test.ts`, `apps/api/test/db/audit-immutability.test.ts`, `docs/threat-model/0003-tenancy-boundary.md`
- Modify: `apps/api/package.json` (`pg`, `@types/pg`, a `db:migrate` script), `.github/workflows/ci.yml` (a PostgreSQL 16 service for the node job, `DATABASE_URL` env), `.env.example` (unchanged values, comment only), `docs/compliance/traceability.md`

**Interfaces:**
- Produces: tables `tenants`, `principals`, `tenant_principals`, `privacy_notices`, `consent_records`, `consent_audit_log`, `consent_receipts` as in the Feasibility Study section 3.5, with these changes from it: keyed-HMAC columns instead of salted SHA-256 (decision D12), `payload_sha256 CHAR(64) NOT NULL` on `consent_audit_log`, `UNIQUE (tenant_id, seq_no)`, and `seq_no` assigned per tenant by the application under `pg_advisory_xact_lock(hashtext(tenant_id::text))`, not by a global sequence. A role `saral_app` (NOLOGIN, no superuser, no BYPASSRLS) owns no tables. Every tenant-owned table has RLS enabled and forced, one policy `USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (same)`. `consent_audit_log` has `REVOKE UPDATE, DELETE, TRUNCATE` from `saral_app` and a `BEFORE UPDATE OR DELETE` trigger that raises. `migrate(client)` applies the SQL files in order inside one transaction each and records them in `schema_migrations`.
- Consumes: the `DATABASE_URL` environment variable (the Docker Compose database for local runs, a service container in CI).

- [ ] **Step 1: Write failing tests.** `rls.test.ts` connects as the owner, runs `migrate`, then for each test opens a transaction, `SET LOCAL ROLE saral_app` and sets `app.tenant_id`: tenant A sees only its own `consent_records`; with `app.tenant_id` unset the role sees zero rows and does not error; an `INSERT` for tenant B while the setting is A is refused; an `UPDATE ... SET tenant_id` moving a row to tenant B is refused; the policy applies to every tenant-owned table (the test lists tables from `pg_class` where `relrowsecurity` is false and fails if any tenant-owned table appears). `audit-immutability.test.ts`: `UPDATE`, `DELETE` and `TRUNCATE` on `consent_audit_log` fail for `saral_app` and for the owner role (the trigger), and a second append with a duplicate `(tenant_id, seq_no)` fails. Add a test that a chain built with `@saral/audit-chain` and inserted through `saral_app` reads back and passes `verifyChain` (integration of Tasks 3 and 7).
- [ ] **Step 2: Run** with the database up (`pnpm db:up`) and `DATABASE_URL` set: `pnpm --filter @saral/api test`. Expected: FAIL, migration files missing.
- [ ] **Step 3: Implement** the migrations and `migrate.ts`. The first line of each test file prints which role the connection uses so a superuser mistake is obvious.
- [ ] **Step 4: Run** the API tests. Expected: all pass, including the 12 existing ones. When `DATABASE_URL` is unset the DB tests fail with a clear message instead of skipping, so CI cannot go green without them.
- [ ] **Step 5: Update CI** with the service container and run `actionlint`. Write the tenancy-boundary threat model and the traceability rows. Run `pnpm verify` and `pnpm db:down`.
- [ ] **Step 6: Commit, push, open a PR with base `feat/notice-generator`.** Then wait for CI on every PR in the stack and fix any red job.

---

## Part 2: finish the P0 MVP and the design

Tasks 8 to 14 complete `docs/PLAN.md` section 4 P0 items 2 to 7 and the design documents. They stay on the same stack and the same rules. Each task below fixes the interfaces other tasks consume; the implementer rules on everything else and records it in the ledger. If time runs out, the order is the cut order: finish and verify each task fully before starting the next, and say plainly in the final report which tasks are not done.

### Task 8: Consent API (branch `feat/consent-api`, base `feat/db-schema-rls`)

**Interfaces:**
- Consumes: `canonicalConsentRecord`, `canonicalAuditEntry` (Task 2), `sealEntry`, `verifyChain`, `buildAnchor` (Task 3), `buildReceiptClaims`, `signReceipt`, `buildJwks`, `ReceiptSigner` (Task 4), the schema (Task 7).
- Produces, in `apps/api/src`: 
  - `auth/` — API keys: publishable `pk_<id>_<secret>` (scope `sdk`) and secret `sk_<id>_<secret>` (scopes `tenant_admin`, `auditor`). Only an HMAC-SHA256 of the secret part (keyed by a server pepper passed in config) is stored, compared in constant time. `@Scopes(...)` decorator and a guard that returns 401 for a missing or invalid key and 403 for a valid key with the wrong scope. Every request runs inside a transaction that does `SET LOCAL ROLE saral_app` and `set_config('app.tenant_id', ...)`.
  - `consent/ConsentService` with `grant(tenantId, input)` and `withdraw(tenantId, consentId, actor)`. Each call, in one transaction: validates the notice exists for the tenant and binds `notice_sha256`, writes `consent_records`, takes the per-tenant advisory lock, appends the next audit entry (`payloadSha256 = sha256Hex(canonicalConsentRecord(...))`), mints and stores the receipt, and writes a webhook outbox row (Task 9 consumes it). A purpose with no grant returns 403 on use (`ConsentService.assertGranted(tenantId, principalId, purposeKey)`).
  - Routes: `POST /v1/consents`, `POST /v1/consents/:id/withdraw`, `GET /v1/consents/:id/receipt`, `GET /.well-known/jwks.json` (public, cacheable), `GET /v1/audit/verify?from=&to=` and `GET /v1/audit/merkle-root?date=` (scope `auditor`), `GET /v1/notices/:id` (public notice URL).
  - `keys/KeyProvider` interface `{ auditHmacKey(version: number): Uint8Array; receiptSigner(): ReceiptSigner; pseudonymKey(): Uint8Array }`, with an environment-backed implementation for development that refuses to start in `NODE_ENV=production` and a placeholder for the KMS adapter. Pseudonyms: `HMAC(pseudonymKey, phone_e164 || tenantId)` per D12.
- Tests (written first): unit tests for the guard and key hashing; integration tests against real PostgreSQL through Nest's test app: consent grant returns a JWT that `verifyReceipt` accepts using the JWKS route; withdrawal appends a second audit entry and the chain verifies; tenant A's key cannot read tenant B's consent (404, not 403); the `sdk` scope cannot call `/v1/audit/verify`; a tampered row makes `/v1/audit/verify` report the failing `seqNo`; the audit row count equals the number of user-facing actions; 100 concurrent grants for one tenant produce 100 contiguous `seq_no` values and a valid chain (Review Focus: lock correctness).

### Task 9: Webhooks (branch `feat/webhooks`, base `feat/consent-api`)

**Interfaces:**
- Produces, in `apps/api/src/webhooks`: `signWebhook(secret: Uint8Array, timestamp: number, body: string): string` returning `t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">`; `verifyWebhookSignature(secret, header, body, nowSeconds, toleranceSeconds = 300): boolean`; `nextAttemptDelaySeconds(attempt: number): number` (exponential with cap, jitter injected, at most 15 attempts); table `webhook_endpoints` (tenant, URL with https required, secret) and `webhook_deliveries` (outbox: event id as idempotency key, attempt count, next attempt time, state); `WebhookWorker.runOnce(now: Date)` delivering due rows with an injected HTTP client; header `X-Saral-Signature` and `Idempotency-Key`.
- Tests: signature known-answer vector; replay outside tolerance rejected; wrong secret rejected; body byte change rejected; the delay schedule is monotonic and capped; a failing endpoint is retried up to 15 times then marked `failed`; a 2xx marks `delivered` once even when `runOnce` runs twice concurrently; private-address and non-HTTPS URLs are refused at registration (SSRF guard: loopback, link-local, RFC 1918, and a hostname that resolves to one).

### Task 10: Consent SDK (branch `feat/consent-sdk`, base `feat/webhooks`)

**Interfaces:**
- Produces, in `packages/sdk-js/src`: `init({ publishableKey, apiBase, noticeId, purposes, locale, container? })` and `window.SaralPrivacy.init`; a banner with a granular toggle per purpose, non-essential purposes off by default, a "Reject all" button as prominent as "Accept all", a persistent "Manage consent" entry that withdraws as easily as it grants; `getConsent()`; `onChange(cb)`; an age gate hook for Rule 10. The SDK stores only the receipt id and per-purpose state in `localStorage` under one key, never an identifier of the person. All text is set through `textContent`.
- Tests: defaults off; accept-all and reject-all send the right body; withdraw sends one request; a network failure leaves state unchanged and shows an error; the IIFE bundle is still under 25 kB gzipped (`size-limit`) and works when evaluated in a `vm` context; no `innerHTML` use (lint rule plus a test that scans the source).

### Task 11: Data-principal rights (branch `feat/dsr`, base `feat/consent-sdk`)

**Interfaces:**
- Produces: table `dsr_requests` with RLS; pure `dsrTransition(state, event)` over states `submitted`, `identity_pending`, `in_review`, `fulfilled`, `rejected`, `closed` and a table of legal transitions; `slaDueAt(submittedAt: Date, type)` (30 days as the working default, marked unverified against the Rules); routes `POST /v1/dsr` (scope `sdk`), `GET /v1/dsr` and `POST /v1/dsr/:id/transition` (scope `dpo`); every transition writes an audit entry and a webhook; erasure fulfilment deletes the identifier-to-pseudonym mapping and leaves audit rows intact (the plan's erasure design, flagged for legal review).
- Tests: every illegal transition is rejected; every legal one succeeds; overdue requests are listed by a query; erasure removes the mapping and `verifyChain` still passes; one tenant never sees another's requests.

### Task 12: Staff authentication with MFA (branch `feat/staff-auth`, base `feat/dsr`)

**Interfaces:**
- Produces: staff accounts per tenant with roles `tenant_admin` and `dpo`; passwords hashed with scrypt (parameters pinned in the ADR); RFC 6238 TOTP with a 30-second step and a one-step window, secrets encrypted at rest with an application key; short-lived access tokens signed RS256 with the receipt-independent session key; recovery codes stored hashed; login rate limiting; `POST /v1/auth/login`, `/v1/auth/mfa/enroll`, `/v1/auth/mfa/verify`. A staff session without completed MFA gets 403 on every scoped route.
- Tests: the TOTP generator matches the RFC 6238 test vectors; a login without MFA yields no scoped access; five failed logins lock the account for a period; a used recovery code cannot be reused; a replayed TOTP code inside its window is rejected.

### Task 13: Dashboard UI and design system (branch `feat/dashboard`, base `feat/staff-auth`)

**Interfaces:**
- Produces, in `apps/web`: a design-token layer (CSS variables for colour, spacing, type, with light and dark values that meet WCAG AA contrast), shared components, and these screens: sign-in with MFA, consent funnel and audit-health overview, notices list and publish, consent search, DSR queue with SLA badges and the transition actions, a verifier panel that runs the audit check and shows the result. Use the `frontend-design` skill for direction. An API client with typed responses generated from the OpenAPI document of Task 14.
- Tests: component tests for each screen's loading, empty, error and success states; keyboard-only operation of the DSR queue; a contrast test over the token pairs.

### Task 14: Design documents and OpenAPI (branch `docs/design`, base `feat/dashboard`)

**Interfaces:**
- Produces: `docs/design/HLD.md` (system context, components, data flows, trust boundaries, deployment on AWS ap-south-1, failure modes), `docs/design/LLD.md` (module by module as built, with the state machines and the canonical formats), `docs/design/openapi.yaml` (every route built in Tasks 8 to 12, validated in CI by a lint step), an updated `docs/PLAN.md` status and calendar (what is built, what remains of P0 and P1), and updated `README.md` and `docs/compliance/traceability.md`. A design-versus-code check: a test that fails when a route in the Nest app is missing from `openapi.yaml`.

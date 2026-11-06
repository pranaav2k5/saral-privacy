import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "@saral/audit-chain";
import { ReceiptError, buildReceiptClaims, signReceipt, type PiiController, type ReceiptPurpose } from "@saral/receipts";
import { canonicalConsentRecord, type CollectionMethod, type ConsentFields, type PurposeGrant } from "@saral/schemas";
import type pg from "pg";
import { AuditService } from "../audit/audit.service.js";
import type { ApiKeyKind } from "../auth/api-keys.js";
import { Database } from "../db/database.js";
import { KEY_PROVIDER, type KeyProvider } from "../keys/key-provider.js";
import { SETTINGS, type Settings } from "../settings.js";
import { receiptPolicyUrl } from "./policy-url.js";
import { WebhookService } from "../webhooks/webhook.service.js";

export interface GrantInput {
  noticeId: string;
  /** Normalised phone number or email. Used for the pseudonym and then discarded. */
  identifier: string;
  purposes: { key: string; granted: boolean }[];
  keyKind: ApiKeyKind;
  /** A random key the caller chose for this request. Retrying with it returns the first result instead of recording twice. */
  idempotencyKey?: string;
}

export interface PurposeDefinition {
  key: string;
  purpose: string;
  purposeCategory: string[];
  piiCategory: string[];
  termination: string;
  retentionDays: number;
  thirdPartyDisclosure: boolean;
  thirdPartyName?: string;
  primaryPurpose?: boolean;
}

interface TenantProfile {
  controller?: PiiController;
  policyUrl?: string;
  service?: string;
}

const COLLECTION: Record<CollectionMethod, string> = {
  web_sdk: "web_sdk: consent banner on the organisation's website or app",
  api: "api: server-side call by the organisation",
  dpo_entry: "dpo_entry: recorded by the data protection officer",
};

type ConsentRow = {
  id: string; tenant_id: string; principal_id: string; notice_id: string; notice_sha256: string;
  purposes: { key: string; granted: boolean; retentionDays: number }[]; status: "granted" | "withdrawn" | "expired";
  granted_at: Date; withdrawn_at: Date | null; collection_method: CollectionMethod; pseudonym_hmac: string;
};

const toFields = (r: ConsentRow): ConsentFields => ({
  tenantId: r.tenant_id, consentId: r.id, principalId: r.principal_id, noticeId: r.notice_id, noticeSha256: r.notice_sha256,
  purposes: r.purposes.map((p): PurposeGrant => ({ key: p.key, granted: p.granted, retentionDays: p.retentionDays })),
  status: r.status, grantedAt: r.granted_at.toISOString(), withdrawnAt: r.withdrawn_at ? r.withdrawn_at.toISOString() : null,
  collectionMethod: r.collection_method,
});

@Injectable()
export class ConsentService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly webhooks: WebhookService,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  /** Keyed HMAC of the person's identifier and the tenant (decision D12). Tenant-scoped, so tenants cannot link people. */
  pseudonym(identifier: string, tenantId: string): string {
    return createHmac("sha256", this.keys.pseudonymKey()).update(JSON.stringify(["saral.principal", identifier, tenantId])).digest("hex");
  }

  /** `reused` is true when the request repeats an earlier one (same Idempotency-Key) and the first result is returned unchanged. */
  async grant(tenantId: string, input: GrantInput): Promise<{ consentId: string; receiptId: string; receipt: string; reused: boolean }> {
    const pseudonym = this.pseudonym(input.identifier, tenantId);
    const collectionMethod: CollectionMethod = input.keyKind === "publishable" ? "web_sdk" : "api";
    return this.db.inScope({ tenantId }, async (c) => {
      const profile = (await c.query<{ profile: TenantProfile }>("SELECT profile FROM tenants")).rows[0]?.profile ?? {};
      const notice = (await c.query<{ id: string; canonical_sha256: string; purpose_definitions: PurposeDefinition[]; language: string }>(
        "SELECT id, canonical_sha256, purpose_definitions, language FROM privacy_notices WHERE id = $1", [input.noticeId])).rows[0];
      if (notice === undefined) throw new NotFoundException({ error: "not_found", message: "notice not found" });

      const defs = new Map(notice.purpose_definitions.map((d) => [d.key, d]));
      const purposes: PurposeGrant[] = input.purposes.map((p) => {
        const d = defs.get(p.key);
        if (d === undefined) throw new UnprocessableEntityException({ error: "unknown_purpose", message: `the notice does not define the purpose ${p.key}` });
        return { key: p.key, granted: p.granted, retentionDays: d.retentionDays };
      });
      // One stored order (by key), so the same choices always compare equal and hash the same.
      purposes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      if (!purposes.some((p) => p.granted)) {
        throw new UnprocessableEntityException({ error: "nothing_granted", message: "at least one purpose must be granted; a consent that grants nothing is not recorded" });
      }

      // Serialise grants for the tenant before looking for an earlier request with the same key, so two retries at the
      // same moment cannot both miss each other and record twice.
      await c.query("SELECT audit_append_lock($1)", [tenantId]);
      const principalId = await this.principal(c, tenantId, pseudonym);
      // A retry carrying the same random key returns the first result. Nothing else is ever recognised: matching on the
      // identifier alone would hand a stranger who knows it a stored receipt, and tell them the person is a customer.
      if (input.idempotencyKey !== undefined) {
        const prior = (await c.query<{ consent_id: string; status: string; principal_id: string; notice_id: string; purposes: { key: string; granted: boolean; retentionDays: number }[]; receipt_id: string; jwt: string }>(
          `SELECT r.id AS consent_id, r.status, r.principal_id, r.notice_id, r.purposes, rc.id AS receipt_id, rc.jwt FROM consent_records r
           JOIN consent_receipts rc ON rc.tenant_id = r.tenant_id AND rc.consent_id = r.id WHERE r.idempotency_key = $1`, [input.idempotencyKey])).rows[0];
        if (prior !== undefined) {
          const shape = (list: { key: string; granted: boolean; retentionDays: number }[]) => list.map((p) => `${p.key}:${String(p.granted)}:${String(p.retentionDays)}`).sort().join(",");
          // A consent that has since been withdrawn or expired is never replayed as if it were current: use a new key.
          if (prior.status !== "granted" || prior.principal_id !== principalId || prior.notice_id !== notice.id || shape(prior.purposes) !== shape(purposes)) {
            throw new ConflictException({ error: "idempotency_key_reused", message: "this Idempotency-Key was already used for a different request, or its consent is no longer granted; use a new key" });
          }
          return { consentId: prior.consent_id, receiptId: prior.receipt_id, receipt: prior.jwt, reused: true };
        }
      }
      const consentId = randomUUID();
      const grantedAt = new Date();
      const fields: ConsentFields = {
        tenantId, consentId, principalId, noticeId: notice.id, noticeSha256: notice.canonical_sha256, purposes,
        status: "granted", grantedAt: grantedAt.toISOString(), withdrawnAt: null, collectionMethod,
      };
      const payloadSha256 = sha256Hex(canonicalConsentRecord(fields));
      await c.query(
        `INSERT INTO consent_records (id, tenant_id, principal_id, notice_id, notice_sha256, purposes, status, granted_at, collection_method, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, 'granted', $7, $8, $9)`,
        [consentId, tenantId, principalId, notice.id, notice.canonical_sha256, JSON.stringify(purposes), fields.grantedAt, collectionMethod, input.idempotencyKey ?? null],
      );
      await this.audit.append(c, tenantId, { actorType: "principal", actorId: principalId, action: "consent.granted", refTable: "consent_records", refId: consentId, payloadSha256 });

      const receiptId = randomUUID();
      let jwt: string;
      try {
        const claims = buildReceiptClaims({
          receiptId, principalId, consentedAt: grantedAt, collectionMethod: COLLECTION[collectionMethod], language: notice.language,
          controller: profile.controller as PiiController, policyUrl: receiptPolicyUrl(this.settings.publicBaseUrl, profile.policyUrl, notice.id) as string, service: profile.service as string,
          consentId, noticeId: notice.id, noticeSha256: notice.canonical_sha256,
          purposes: purposes.filter((p) => p.granted).map((p): ReceiptPurpose => {
            const d = defs.get(p.key) as PurposeDefinition;
            return {
              purpose: d.purpose, consentType: "EXPLICIT", purposeCategory: d.purposeCategory, piiCategory: d.piiCategory,
              termination: d.termination, thirdPartyDisclosure: d.thirdPartyDisclosure,
              ...(d.thirdPartyName !== undefined ? { thirdPartyName: d.thirdPartyName } : {}),
              ...(d.primaryPurpose !== undefined ? { primaryPurpose: d.primaryPurpose } : {}),
            };
          }),
        });
        jwt = await signReceipt(claims, this.keys.receiptSigner());
      } catch (e) {
        if (e instanceof ReceiptError) {
          throw new UnprocessableEntityException({ error: "incomplete_setup", message: `the tenant profile or the notice's purpose definitions are incomplete: ${e.message}` });
        }
        throw e;
      }
      await c.query("INSERT INTO consent_receipts (id, tenant_id, consent_id, jwt, jwks_kid) VALUES ($1, $2, $3, $4, $5)", [receiptId, tenantId, consentId, jwt, this.keys.receiptSigner().kid]);
      // Ids and states only: no identifier, and no receipt text.
      await this.webhooks.enqueue(c, tenantId, "consent.granted", {
        consentId, receiptId, noticeId: notice.id, principalId, collectionMethod, status: "granted",
        purposes: purposes.map((p) => ({ key: p.key, granted: p.granted })),
      });
      return { consentId, receiptId, receipt: jwt, reused: false };
    });
  }

  private async principal(c: pg.PoolClient, tenantId: string, pseudonym: string): Promise<string> {
    const existing = await c.query<{ id: string }>("SELECT id FROM tenant_principals WHERE pseudonym_hmac = $1", [pseudonym]);
    if (existing.rows[0]) return existing.rows[0].id;
    const id = randomUUID();
    await c.query("INSERT INTO tenant_principals (tenant_id, id, pseudonym_hmac) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, pseudonym_hmac) DO NOTHING", [tenantId, id, pseudonym]);
    return (await c.query<{ id: string }>("SELECT id FROM tenant_principals WHERE pseudonym_hmac = $1", [pseudonym])).rows[0]?.id as string;
  }

  /** Moves one granted consent to withdrawn, appends its audit entry and queues its webhook. Runs inside the caller's transaction. */
  private async finish(c: pg.PoolClient, tenantId: string, row: ConsentRow, withdrawnAt: Date): Promise<void> {
    await c.query("UPDATE consent_records SET status = 'withdrawn', withdrawn_at = $2 WHERE id = $1", [row.id, withdrawnAt]);
    const after: ConsentFields = { ...toFields(row), status: "withdrawn", withdrawnAt: withdrawnAt.toISOString() };
    await this.audit.append(c, tenantId, {
      actorType: "principal", actorId: row.principal_id, action: "consent.withdrawn", refTable: "consent_records", refId: row.id,
      payloadSha256: sha256Hex(canonicalConsentRecord(after)),
    });
    await this.webhooks.enqueue(c, tenantId, "consent.withdrawn", {
      consentId: row.id, noticeId: row.notice_id, principalId: row.principal_id, status: "withdrawn", withdrawnAt: after.withdrawnAt as string,
    });
  }

  /** Withdraws a consent by id. The caller must prove they are the person: a wrong identifier looks the same as an unknown consent. */
  async withdraw(tenantId: string, consentId: string, identifier: string): Promise<{ consentId: string; status: "withdrawn"; withdrawnAt: string }> {
    const claimed = Buffer.from(this.pseudonym(identifier, tenantId), "hex");
    return this.db.inScope({ tenantId }, async (c) => {
      const row = (await c.query<ConsentRow>(
        `SELECT r.*, p.pseudonym_hmac FROM consent_records r JOIN tenant_principals p ON p.tenant_id = r.tenant_id AND p.id = r.principal_id
         WHERE r.id = $1 FOR UPDATE OF r`, [consentId])).rows[0];
      const actual = row ? Buffer.from(row.pseudonym_hmac, "hex") : Buffer.alloc(32);
      if (row === undefined || !timingSafeEqual(claimed, actual)) throw new NotFoundException({ error: "not_found", message: "consent not found" });
      if (row.status !== "granted") throw new ConflictException({ error: "not_granted", message: `the consent is already ${row.status}` });
      const withdrawnAt = new Date();
      await this.finish(c, tenantId, row, withdrawnAt);
      return { consentId, status: "withdrawn", withdrawnAt: withdrawnAt.toISOString() };
    });
  }

  /**
   * Withdraws every granted consent the person has (optionally for one notice), found by identifier alone. Only a tenant's
   * server may call it (a secret key), after it has verified the person itself: the identifier alone proves nothing, and a
   * publishable key is visible in a web page. Nothing found, or a wrong identifier, is the same 404.
   */
  async withdrawAll(tenantId: string, identifier: string, noticeId?: string): Promise<{ status: "withdrawn"; consentIds: string[]; withdrawnAt: string }> {
    const pseudonym = this.pseudonym(identifier, tenantId);
    return this.db.inScope({ tenantId }, async (c) => {
      await c.query("SELECT audit_append_lock($1)", [tenantId]);
      const rows = (await c.query<ConsentRow>(
        `SELECT r.*, p.pseudonym_hmac FROM consent_records r JOIN tenant_principals p ON p.tenant_id = r.tenant_id AND p.id = r.principal_id
         WHERE p.pseudonym_hmac = $1 AND r.status = 'granted' AND ($2::uuid IS NULL OR r.notice_id = $2)
         ORDER BY r.granted_at FOR UPDATE OF r`, [pseudonym, noticeId ?? null])).rows;
      if (rows.length === 0) throw new NotFoundException({ error: "not_found", message: "no consent to withdraw" });
      const withdrawnAt = new Date();
      for (const row of rows) await this.finish(c, tenantId, row, withdrawnAt);
      return { status: "withdrawn", consentIds: rows.map((r) => r.id), withdrawnAt: withdrawnAt.toISOString() };
    });
  }

  async receipt(tenantId: string, consentId: string): Promise<{ consentId: string; receiptId: string; receipt: string }> {
    return this.db.inScope({ tenantId }, async (c) => {
      const r = (await c.query<{ id: string; jwt: string }>("SELECT id, jwt FROM consent_receipts WHERE consent_id = $1 ORDER BY issued_at LIMIT 1", [consentId])).rows[0];
      if (r === undefined) throw new NotFoundException({ error: "not_found", message: "receipt not found" });
      return { consentId, receiptId: r.id, receipt: r.jwt };
    });
  }
}

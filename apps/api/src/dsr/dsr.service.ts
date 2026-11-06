import { ConflictException, GoneException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes, randomUUID } from "node:crypto";
import { sha256Hex } from "@saral/audit-chain";
import type pg from "pg";
import { AuditService } from "../audit/audit.service.js";
import { ConsentService } from "../consent/consent.service.js";
import { decryptContact, encryptContact } from "../crypto/contact-crypto.js";
import { Database } from "../db/database.js";
import { KEY_PROVIDER, type KeyProvider } from "../keys/key-provider.js";
import { PrincipalService } from "../principals/principal.service.js";
import { WebhookService } from "../webhooks/webhook.service.js";
import { allowedNext, canTransition, slaDueAt, type DsrState, type DsrType } from "./state.js";

type Row = {
  id: string; tenant_id: string; principal_id: string; type: DsrType; state: DsrState; details: string | null;
  submitted_at: Date; due_at: Date; decided_reason: string | null; closed_at: Date | null;
};

export interface DsrView {
  id: string;
  type: DsrType;
  state: DsrState;
  submittedAt: string;
  dueAt: string;
  overdue: boolean;
  decidedReason: string | null;
  closedAt: string | null;
  details?: string | null;
}

const OPEN: readonly DsrState[] = ["submitted", "identity_pending", "in_review"];

const view = (r: Row, withDetails: boolean, now = Date.now()): DsrView => ({
  id: r.id, type: r.type, state: r.state, submittedAt: r.submitted_at.toISOString(), dueAt: r.due_at.toISOString(),
  overdue: OPEN.includes(r.state) && r.due_at.getTime() < now,
  decidedReason: r.decided_reason, closedAt: r.closed_at ? r.closed_at.toISOString() : null,
  ...(withDetails ? { details: r.details } : {}),
});

/** The audit payload hash of a rights request in a given state: a small canonical array, like the other record kinds. */
const payload = (r: Row, state: DsrState, reason: string | null): string =>
  sha256Hex(JSON.stringify(["saral.dsr", 1, r.tenant_id, r.id, r.principal_id, r.type, state, r.due_at.toISOString(), reason]));

@Injectable()
export class DsrService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly webhooks: WebhookService,
    private readonly principals: PrincipalService,
    private readonly consents: ConsentService,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
  ) {}

  /** A person submits a request. The answer is the same whether or not Saral has seen them before. */
  async submit(tenantId: string, input: { type: DsrType; identifier: string; details?: string }): Promise<DsrView> {
    const pseudonym = this.principals.pseudonym(input.identifier, tenantId);
    return this.db.inScope({ tenantId }, async (c) => {
      await c.query("SELECT audit_append_lock($1)", [tenantId]);
      const principalId = await this.principals.findOrCreate(c, tenantId, pseudonym);
      // The only place the raw contact is kept, sealed, so the data protection officer can answer.
      await c.query(
        `INSERT INTO principal_contacts (tenant_id, principal_id, sealed) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, principal_id) DO UPDATE SET sealed = EXCLUDED.sealed`,
        [tenantId, principalId, Buffer.from(encryptContact(this.keys.contactKey(), tenantId, principalId, input.identifier))],
      );
      const id = randomUUID();
      const submittedAt = new Date();
      const row = (await c.query<Row>(
        `INSERT INTO dsr_requests (id, tenant_id, principal_id, type, details, submitted_at, due_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [id, tenantId, principalId, input.type, input.details ?? null, submittedAt, slaDueAt(submittedAt, input.type)],
      )).rows[0] as Row;
      await this.audit.append(c, tenantId, { actorType: "principal", actorId: principalId, action: "dsr.submitted", refTable: "dsr_requests", refId: id, payloadSha256: payload(row, "submitted", null) });
      await this.webhooks.enqueue(c, tenantId, "dsr.submitted", { requestId: id, type: row.type, state: row.state, dueAt: row.due_at.toISOString(), principalId });
      return view(row, false);
    });
  }

  async list(tenantId: string, filter: { state?: DsrState; overdue?: boolean }): Promise<DsrView[]> {
    return this.db.inScope({ tenantId }, async (c) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.state !== undefined) {
        params.push(filter.state);
        where.push(`state = $${String(params.length)}`);
      }
      if (filter.overdue === true) where.push("due_at < now() AND state IN ('submitted', 'identity_pending', 'in_review')");
      const rows = (await c.query<Row>(`SELECT * FROM dsr_requests ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY due_at, id`, params)).rows;
      return rows.map((r) => view(r, true));
    });
  }

  async get(tenantId: string, id: string): Promise<DsrView> {
    return this.db.inScope({ tenantId }, async (c) => view(await this.load(c, id, false), true));
  }

  private async load(c: pg.PoolClient, id: string, lock: boolean): Promise<Row> {
    const row = (await c.query<Row>(`SELECT * FROM dsr_requests WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`, [id])).rows[0];
    if (row === undefined) throw new NotFoundException({ error: "not_found", message: "request not found" });
    return row;
  }

  /** Moves a request to a new state. One transaction: the move, its audit entry, its webhook, and (for a fulfilled erasure) the erasure. */
  async transition(tenantId: string, keyId: string, id: string, to: DsrState, reason?: string): Promise<DsrView> {
    return this.db.inScope({ tenantId }, async (c) => {
      await c.query("SELECT audit_append_lock($1)", [tenantId]);
      const row = await this.load(c, id, true);
      if (!canTransition(row.state, to)) {
        throw new ConflictException({ error: "illegal_transition", from: row.state, to, allowed: allowedNext(row.state), message: `a request cannot move from ${row.state} to ${to}` });
      }
      const now = new Date();
      const updated = (await c.query<Row>(
        `UPDATE dsr_requests SET state = $2, decided_reason = COALESCE($3, decided_reason), closed_at = $4 WHERE id = $1 RETURNING *`,
        [id, to, to === "rejected" ? (reason ?? null) : null, to === "closed" ? now : null],
      )).rows[0] as Row;
      if (to === "fulfilled" && row.type === "erasure") await this.erase(c, tenantId, row.principal_id, now);
      await this.audit.append(c, tenantId, { actorType: "dpo", actorId: `api-key:${keyId}`, action: "dsr.transitioned", refTable: "dsr_requests", refId: id, payloadSha256: payload(updated, to, updated.decided_reason) });
      await this.webhooks.enqueue(c, tenantId, "dsr.transitioned", { requestId: id, type: row.type, from: row.state, state: to, dueAt: updated.due_at.toISOString() });
      return view(updated, true);
    });
  }

  /**
   * Erasure (docs/PLAN.md section 5.2): withdraw the person's consents, delete the sealed contact, and replace their
   * pseudonym with a random value so their identifier no longer leads to them. Audit entries stay (they hold only ids and
   * hashes), so the chain still verifies. Whether this satisfies the Act is a question for the lawyer advisor.
   */
  private async erase(c: pg.PoolClient, tenantId: string, principalId: string, at: Date): Promise<void> {
    await this.consents.withdrawAllForPrincipal(c, tenantId, principalId, at);
    await c.query("DELETE FROM principal_contacts WHERE principal_id = $1", [principalId]);
    await c.query("UPDATE tenant_principals SET pseudonym_hmac = $2 WHERE id = $1", [principalId, randomBytes(32).toString("hex")]);
  }

  /** Shows the person's contact to the data protection officer. Every read is an audit event saying who read it. */
  async revealContact(tenantId: string, keyId: string, id: string): Promise<{ contact: string }> {
    return this.db.inScope({ tenantId }, async (c) => {
      await c.query("SELECT audit_append_lock($1)", [tenantId]);
      const row = await this.load(c, id, false);
      const sealed = (await c.query<{ sealed: Buffer }>("SELECT sealed FROM principal_contacts WHERE principal_id = $1", [row.principal_id])).rows[0];
      if (sealed === undefined) throw new GoneException({ error: "gone", message: "the contact was erased or was never captured" });
      await this.audit.append(c, tenantId, { actorType: "dpo", actorId: `api-key:${keyId}`, action: "dsr.contact_revealed", refTable: "dsr_requests", refId: id, payloadSha256: payload(row, row.state, null) });
      return { contact: decryptContact(this.keys.contactKey(), tenantId, row.principal_id, new Uint8Array(sealed.sealed)) };
    });
  }
}

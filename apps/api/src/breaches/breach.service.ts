import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { sha256Hex } from "@saral/audit-chain";
import type pg from "pg";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/access.js";
import { Database } from "../db/database.js";
import { bad } from "../http/validate.js";
import type { Nature, ReportInput } from "./breach-input.js";
import { boardDeadline, canTransition, type BreachState } from "./state.js";
import { renderBoardNotification, renderPrincipalNotice, type IncidentFacts, type Organisation } from "./templates.js";

type Row = {
  id: string; tenant_id: string; state: BreachState; title: string; description: string; discovered_at: Date; occurred_at: Date | null;
  nature: Nature[]; data_categories: string[]; approx_principals: number | null; likely_consequences: string; measures_taken: string;
  reported_at: Date; reported_by: string; signed_off_at: Date | null; signed_off_by: string | null;
  signed_off_board_sha256: string | null; signed_off_principal_sha256: string | null;
  board_notified_at: Date | null; board_reference: string | null; principals_notified_at: Date | null; principals_how: string | null;
  principals_count: number | null; closed_at: Date | null; closing_note: string | null;
};

export interface BreachView {
  id: string;
  state: BreachState;
  title: string;
  description: string;
  discoveredAt: string;
  occurredAt: string | null;
  nature: Nature[];
  dataCategories: string[];
  approxPrincipalsAffected: number | null;
  likelyConsequences: string;
  measuresTaken: string;
  reportedAt: string;
  reportedBy: string;
  /** Seventy-two hours after the breach was found: when the Board has to have been told by (the period is a working default, not confirmed). */
  boardDeadline: string;
  /** The Board has not been told and the deadline has passed. */
  boardOverdue: boolean;
  /** The Board was told after the deadline. Null until it has been told. */
  boardNotifiedLate: boolean | null;
  signedOffAt: string | null;
  signedOffBy: string | null;
  boardNotifiedAt: string | null;
  boardReference: string | null;
  principalsNotifiedAt: string | null;
  principalsHow: string | null;
  principalsCount: number | null;
  closedAt: string | null;
  closingNote: string | null;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

function view(r: Row, now = Date.now()): BreachView {
  const deadline = boardDeadline(r.discovered_at);
  return {
    id: r.id, state: r.state, title: r.title, description: r.description, discoveredAt: r.discovered_at.toISOString(), occurredAt: iso(r.occurred_at),
    nature: r.nature, dataCategories: r.data_categories, approxPrincipalsAffected: r.approx_principals, likelyConsequences: r.likely_consequences,
    measuresTaken: r.measures_taken, reportedAt: r.reported_at.toISOString(), reportedBy: r.reported_by, boardDeadline: deadline.toISOString(),
    boardOverdue: r.board_notified_at === null && now > deadline.getTime(),
    boardNotifiedLate: r.board_notified_at === null ? null : r.board_notified_at.getTime() > deadline.getTime(),
    signedOffAt: iso(r.signed_off_at), signedOffBy: r.signed_off_by, boardNotifiedAt: iso(r.board_notified_at), boardReference: r.board_reference,
    principalsNotifiedAt: iso(r.principals_notified_at), principalsHow: r.principals_how, principalsCount: r.principals_count,
    closedAt: iso(r.closed_at), closingNote: r.closing_note,
  };
}

const facts = (r: Row): IncidentFacts => ({
  title: r.title, description: r.description, discoveredAt: r.discovered_at.toISOString(), occurredAt: iso(r.occurred_at), nature: r.nature,
  dataCategories: r.data_categories, approxPrincipals: r.approx_principals, likelyConsequences: r.likely_consequences, measuresTaken: r.measures_taken,
});

/**
 * What an audit entry holds for an incident: the action and a hash of the content, never the words, which can mention people.
 * Every step's time is part of it, so the entry also fixes how far the incident had got.
 */
function payload(r: Row, action: string): string {
  const content = sha256Hex(JSON.stringify([r.title, r.description, r.discovered_at.toISOString(), iso(r.occurred_at), [...r.nature].sort(), r.data_categories, r.approx_principals, r.likely_consequences, r.measures_taken]));
  return sha256Hex(JSON.stringify(["saral.breach", 1, r.tenant_id, r.id, action, r.state, content, iso(r.signed_off_at), iso(r.board_notified_at), iso(r.principals_notified_at), iso(r.closed_at)]));
}

type Profile = { controller?: { piiController?: string; contact?: string; email?: string; address?: { streetAddress?: string; addressLocality?: string; postalCode?: string; addressCountry?: string } } };

const LIST_LIMIT = 100;

@Injectable()
export class BreachService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  private async load(c: pg.PoolClient, id: string, lock: boolean): Promise<Row> {
    const row = (await c.query<Row>(`SELECT * FROM breach_incidents WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`, [id])).rows[0];
    if (row === undefined) throw new NotFoundException({ error: "not_found", message: "incident not found" });
    return row;
  }

  private async record(c: pg.PoolClient, auth: AuthContext, row: Row, action: string): Promise<void> {
    await this.audit.append(c, row.tenant_id, {
      actorType: auth.scopes.includes("dpo") ? "dpo" : "system", actorId: auth.actor, action, refTable: "breach_incidents", refId: row.id,
      payloadSha256: payload(row, action),
    });
  }

  /** The organisation as the drafts name it, from the profile the operator set. Without a controller there is nobody to name. */
  private async organisation(c: pg.PoolClient): Promise<Organisation> {
    const t = (await c.query<{ name: string; profile: Profile | null }>("SELECT name, profile FROM tenants")).rows[0];
    const ctl = t?.profile?.controller;
    if (ctl?.piiController === undefined || ctl.contact === undefined || ctl.email === undefined || ctl.address === undefined) {
      throw new UnprocessableEntityException({ error: "incomplete_setup", message: "the organisation's profile does not say who the controller is and how to reach them, so the drafts cannot be written; ask the operator to set the profile" });
    }
    const a = ctl.address;
    const street = [a.streetAddress, [a.addressLocality, a.postalCode].filter((x) => x !== undefined && x !== "").join(" "), a.addressCountry].filter((x) => x !== undefined && x !== "").join(", ");
    return { name: ctl.piiController, contact: ctl.contact, email: ctl.email, address: street };
  }

  private drafts(r: Row, org: Organisation): { boardNotification: string; principalNotice: string; boardDeadline: string } {
    const deadline = boardDeadline(r.discovered_at).toISOString();
    return { boardNotification: renderBoardNotification(facts(r), org, deadline), principalNotice: renderPrincipalNotice(facts(r), org), boardDeadline: deadline };
  }

  private illegal(from: BreachState, to: BreachState): ConflictException {
    return new ConflictException({ error: "illegal_transition", from, to, message: `an incident cannot move from ${from} to ${to}` });
  }

  async report(tenantId: string, auth: AuthContext, input: ReportInput): Promise<BreachView> {
    const id = randomUUID();
    return this.db.inScope({ tenantId }, async (c) => {
      await c.query("SELECT audit_append_lock($1)", [tenantId]);
      const row = (await c.query<Row>(
        `INSERT INTO breach_incidents (id, tenant_id, title, description, discovered_at, occurred_at, nature, data_categories, approx_principals, likely_consequences, measures_taken, reported_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [id, tenantId, input.title, input.description, input.discoveredAt, input.occurredAt, input.nature, input.dataCategories, input.approxPrincipals, input.likelyConsequences, input.measuresTaken, auth.actor],
      )).rows[0] as Row;
      await this.record(c, auth, row, "breach.reported");
      return view(row);
    });
  }

  async list(tenantId: string): Promise<BreachView[]> {
    return this.db.inScope({ tenantId }, async (c) => {
      const rows = (await c.query<Row>("SELECT * FROM breach_incidents ORDER BY discovered_at DESC, id LIMIT $1", [LIST_LIMIT])).rows;
      const now = Date.now();
      return rows.map((r) => view(r, now));
    });
  }

  async get(tenantId: string, id: string): Promise<BreachView> {
    return this.db.inScope({ tenantId }, async (c) => view(await this.load(c, id, false)));
  }

  /** Corrects a report. Only until it is signed off; what was signed off cannot move under the officer's name. */
  async update(tenantId: string, auth: AuthContext, id: string, patch: Partial<ReportInput>): Promise<BreachView> {
    return this.db.inScope({ tenantId }, async (c) => {
      await c.query("SELECT audit_append_lock($1)", [tenantId]);
      const row = await this.load(c, id, true);
      if (row.state !== "reported") throw new ConflictException({ error: "locked", message: "an incident cannot be changed once it has been signed off" });
      const next = {
        title: patch.title ?? row.title, description: patch.description ?? row.description, discoveredAt: patch.discoveredAt ?? row.discovered_at,
        occurredAt: "occurredAt" in patch ? (patch.occurredAt ?? null) : row.occurred_at, nature: patch.nature ?? row.nature,
        dataCategories: patch.dataCategories ?? row.data_categories, approx: "approxPrincipals" in patch ? (patch.approxPrincipals ?? null) : row.approx_principals,
        consequences: patch.likelyConsequences ?? row.likely_consequences, measures: patch.measuresTaken ?? row.measures_taken,
      };
      if (next.occurredAt !== null && next.occurredAt.getTime() > next.discoveredAt.getTime()) throw bad("occurredAt", "cannot be after the time it was found");
      const updated = (await c.query<Row>(
        `UPDATE breach_incidents SET title = $2, description = $3, discovered_at = $4, occurred_at = $5, nature = $6, data_categories = $7, approx_principals = $8,
           likely_consequences = $9, measures_taken = $10 WHERE id = $1 RETURNING *`,
        [id, next.title, next.description, next.discoveredAt, next.occurredAt, next.nature, next.dataCategories, next.approx, next.consequences, next.measures],
      )).rows[0] as Row;
      await this.record(c, auth, updated, "breach.updated");
      return view(updated);
    });
  }

  async getDrafts(tenantId: string, id: string): Promise<{ boardNotification: string; principalNotice: string; boardDeadline: string }> {
    return this.db.inScope({ tenantId }, async (c) => this.drafts(await this.load(c, id, false), await this.organisation(c)));
  }

  /** The officer signs off the drafts. What the drafts said is kept as two hashes, and the incident can no longer be changed. */
  async signOff(tenantId: string, auth: AuthContext, id: string): Promise<BreachView> {
    return this.db.inScope({ tenantId }, async (c) => {
      await c.query("SELECT audit_append_lock($1)", [tenantId]);
      const row = await this.load(c, id, true);
      if (!canTransition(row.state, "signed_off")) throw this.illegal(row.state, "signed_off");
      const d = this.drafts(row, await this.organisation(c));
      const updated = (await c.query<Row>(
        `UPDATE breach_incidents SET state = 'signed_off', signed_off_at = now(), signed_off_by = $2, signed_off_board_sha256 = $3, signed_off_principal_sha256 = $4 WHERE id = $1 RETURNING *`,
        [id, auth.actor, sha256Hex(d.boardNotification), sha256Hex(d.principalNotice)],
      )).rows[0] as Row;
      await this.record(c, auth, updated, "breach.signed_off");
      return view(updated);
    });
  }

  /** Records that the Board was told, when, and the reference it gave. Saral does not send anything to the Board. */
  async boardNotified(tenantId: string, auth: AuthContext, id: string, input: (discoveredAt: Date) => { notifiedAt: Date; reference: string }): Promise<BreachView> {
    return this.db.inScope({ tenantId }, async (c) => {
      await c.query("SELECT audit_append_lock($1)", [tenantId]);
      const row = await this.load(c, id, true);
      if (!canTransition(row.state, "board_notified")) throw this.illegal(row.state, "board_notified");
      const given = input(row.discovered_at);
      const updated = (await c.query<Row>("UPDATE breach_incidents SET state = 'board_notified', board_notified_at = $2, board_reference = $3 WHERE id = $1 RETURNING *", [id, given.notifiedAt, given.reference])).rows[0] as Row;
      await this.record(c, auth, updated, "breach.board_notified");
      return view(updated);
    });
  }

  /** Records that the affected people were told, once, after sign-off. Zero is a valid number: nobody was affected. */
  async principalsNotified(tenantId: string, auth: AuthContext, id: string, input: { how: string; count: number }): Promise<BreachView> {
    return this.db.inScope({ tenantId }, async (c) => {
      await c.query("SELECT audit_append_lock($1)", [tenantId]);
      const row = await this.load(c, id, true);
      if (row.state !== "signed_off" && row.state !== "board_notified") throw this.illegal(row.state, row.state);
      if (row.principals_notified_at !== null) throw new ConflictException({ error: "already_recorded", message: "the notice to the affected people has already been recorded" });
      const updated = (await c.query<Row>("UPDATE breach_incidents SET principals_notified_at = now(), principals_how = $2, principals_count = $3 WHERE id = $1 RETURNING *", [id, input.how, input.count])).rows[0] as Row;
      await this.record(c, auth, updated, "breach.principals_notified");
      return view(updated);
    });
  }

  async close(tenantId: string, auth: AuthContext, id: string, input: { note: string }): Promise<BreachView> {
    return this.db.inScope({ tenantId }, async (c) => {
      await c.query("SELECT audit_append_lock($1)", [tenantId]);
      const row = await this.load(c, id, true);
      if (!canTransition(row.state, "closed")) throw this.illegal(row.state, "closed");
      if (row.principals_notified_at === null) throw new ConflictException({ error: "principals_not_notified", message: "record that the affected people were told before closing the incident" });
      const updated = (await c.query<Row>("UPDATE breach_incidents SET state = 'closed', closed_at = now(), closing_note = $2 WHERE id = $1 RETURNING *", [id, input.note])).rows[0] as Row;
      await this.record(c, auth, updated, "breach.closed");
      return view(updated);
    });
  }
}


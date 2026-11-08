import { Injectable } from "@nestjs/common";
import { sha256Hex } from "@saral/audit-chain";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/access.js";
import { Database } from "../db/database.js";
import { PrincipalService } from "../principals/principal.service.js";

export const SEARCH_LIMIT = 100;
export const DEFAULT_SUMMARY_DAYS = 30;
export const MAX_SUMMARY_DAYS = 366;

export interface ConsentView {
  id: string;
  status: "granted" | "withdrawn" | "expired";
  grantedAt: string;
  withdrawnAt: string | null;
  collectionMethod: string;
  notice: { id: string; version: number; language: string };
  purposes: { key: string; granted: boolean }[];
  receiptId: string | null;
}

export interface Summary {
  from: string;
  to: string;
  totals: { active: number; withdrawn: number; expired: number };
  purposes: { key: string; active: number; withdrawn: number; expired: number }[];
  days: { date: string; granted: number; withdrawn: number }[];
}

type Counts = { active: number; withdrawn: number; expired: number };
const STATE: Record<string, keyof Counts> = { granted: "active", withdrawn: "withdrawn", expired: "expired" };
const none = (): Counts => ({ active: 0, withdrawn: 0, expired: 0 });
const day = (d: Date): string => d.toISOString().slice(0, 10);

/** What the data protection officer sees of consents: one person's, found by identifier, and the organisation's overall picture. */
@Injectable()
export class ConsentReviewService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly principals: PrincipalService,
  ) {}

  /**
   * The consents of the person with this identifier, newest first, at most 100. The identifier is turned into the person's
   * pseudonym and never stored, logged or answered back. A person who has no consent is not created by being searched for. A search
   * that finds someone is an audit event naming who looked and which person, because it is access to a person's data.
   */
  async search(auth: AuthContext, identifier: string): Promise<{ consents: ConsentView[]; truncated: boolean }> {
    const pseudonym = this.principals.pseudonym(identifier, auth.tenantId);
    return this.db.inScope({ tenantId: auth.tenantId }, async (c) => {
      const person = (await c.query<{ id: string }>("SELECT id FROM tenant_principals WHERE pseudonym_hmac = $1", [pseudonym])).rows[0];
      if (person === undefined) return { consents: [], truncated: false };
      const rows = (
        await c.query<{
          id: string; status: ConsentView["status"]; granted_at: Date; withdrawn_at: Date | null; collection_method: string; notice_id: string;
          version: number; language: string; purposes: { key: string; granted: boolean }[]; receipt_id: string | null;
        }>(
          `SELECT r.id, r.status, r.granted_at, r.withdrawn_at, r.collection_method, r.notice_id, n.version, n.language, r.purposes,
                  (SELECT rc.id FROM consent_receipts rc WHERE rc.tenant_id = r.tenant_id AND rc.consent_id = r.id ORDER BY rc.issued_at LIMIT 1) AS receipt_id
           FROM consent_records r JOIN privacy_notices n ON n.tenant_id = r.tenant_id AND n.id = r.notice_id
           WHERE r.principal_id = $1 ORDER BY r.granted_at DESC, r.id LIMIT $2`,
          [person.id, SEARCH_LIMIT + 1],
        )
      ).rows;
      await this.audit.append(c, auth.tenantId, {
        actorType: auth.kind === "session" ? "dpo" : "system", actorId: auth.actor, action: "consent.searched", refTable: "tenant_principals", refId: person.id,
        payloadSha256: sha256Hex(JSON.stringify(["saral.consent_search", 1, auth.tenantId, person.id])),
      });
      return {
        truncated: rows.length > SEARCH_LIMIT,
        consents: rows.slice(0, SEARCH_LIMIT).map((r) => ({
          id: r.id, status: r.status, grantedAt: r.granted_at.toISOString(), withdrawnAt: r.withdrawn_at ? r.withdrawn_at.toISOString() : null,
          collectionMethod: r.collection_method, notice: { id: r.notice_id, version: r.version, language: r.language },
          purposes: r.purposes.map((p) => ({ key: p.key, granted: p.granted })), receiptId: r.receipt_id,
        })),
      };
    });
  }

  /**
   * Counts only. Totals and purposes cover every consent ever recorded (a purpose counts for the consents that agreed to it);
   * the days cover the last `days` UTC days up to and including today, one line each, with the consents given and withdrawn that day.
   */
  async summary(tenantId: string, days: number, now: Date = new Date()): Promise<Summary> {
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const from = new Date(to.getTime() - (days - 1) * 86_400_000);
    const end = new Date(to.getTime() + 86_400_000);
    return this.db.inScope({ tenantId }, async (c) => {
      const totals = none();
      for (const r of (await c.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM consent_records GROUP BY status")).rows) totals[STATE[r.status] as keyof Counts] = r.n;
      const byPurpose = new Map<string, Counts>();
      const purposeRows = await c.query<{ key: string; status: string; n: number }>(
        `SELECT p.value->>'key' AS key, r.status, count(*)::int AS n FROM consent_records r, jsonb_array_elements(r.purposes) AS p(value)
         WHERE (p.value->>'granted')::boolean IS TRUE GROUP BY 1, 2`,
      );
      for (const r of purposeRows.rows) {
        const counts = byPurpose.get(r.key) ?? none();
        counts[STATE[r.status] as keyof Counts] = r.n;
        byPurpose.set(r.key, counts);
      }
      const perDay = async (column: "granted_at" | "withdrawn_at"): Promise<Map<string, number>> => {
        const r = await c.query<{ day: string; n: number }>(
          `SELECT (${column} AT TIME ZONE 'UTC')::date::text AS day, count(*)::int AS n FROM consent_records WHERE ${column} >= $1 AND ${column} < $2 GROUP BY 1`,
          [from, end],
        );
        return new Map(r.rows.map((x) => [x.day, x.n]));
      };
      const granted = await perDay("granted_at");
      const withdrawn = await perDay("withdrawn_at");
      return {
        from: day(from),
        to: day(to),
        totals,
        purposes: [...byPurpose.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, counts]) => ({ key, ...counts })),
        days: Array.from({ length: days }, (_, i) => {
          const date = day(new Date(from.getTime() + i * 86_400_000));
          return { date, granted: granted.get(date) ?? 0, withdrawn: withdrawn.get(date) ?? 0 };
        }),
      };
    });
  }
}

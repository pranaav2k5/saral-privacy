import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { sha256Hex } from "@saral/audit-chain";
import type pg from "pg";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/access.js";
import { Database } from "../db/database.js";
import { canonicalRopa, type RopaDocument } from "./ropa-document.js";

/** An organisation saves a new version when something changes, so a few hundred is more than a lifetime. The limit stops a flood of saves. */
export const MAX_VERSIONS = 200;
const LIST_LIMIT = 100;

type Row = { id: string; tenant_id: string; version: number; document_json: string; document_sha256: string; note: string | null; created_at: Date; created_by: string };

export interface RopaVersionView {
  id: string;
  version: number;
  createdAt: string;
  createdBy: string;
  note: string | null;
  /** SHA-256 of the stored text of the record. */
  sha256: string;
}

const view = (r: Row): RopaVersionView => ({ id: r.id, version: r.version, createdAt: r.created_at.toISOString(), createdBy: r.created_by, note: r.note, sha256: r.document_sha256 });

@Injectable()
export class RopaService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /**
   * Saves the next version. A save that would change nothing (the same record as the latest version) is refused, so the history is a list
   * of changes. The audit entry holds the hash of the stored text, never the words.
   *
   * `basedOn` is the version the person started from (0 when none had been saved). If another version has been saved since, the save is
   * refused with 409 `stale` and the newest version's number, so a person never overwrites a change they have not seen. It is checked
   * first, inside the lock, so two saves from the same version cannot both succeed. Without it the save is the next version.
   */
  async create(tenantId: string, auth: AuthContext, document: RopaDocument, note: string | undefined, basedOn?: number): Promise<RopaVersionView> {
    const text = canonicalRopa(document);
    const hash = sha256Hex(text);
    const id = randomUUID();
    return this.db.inScope({ tenantId }, async (c) => {
      await c.query("SELECT audit_append_lock($1)", [tenantId]);
      const latest = (await c.query<{ version: number; document_sha256: string }>("SELECT version, document_sha256 FROM ropa_versions ORDER BY version DESC LIMIT 1")).rows[0];
      const newest = latest?.version ?? 0;
      if (basedOn !== undefined && basedOn !== newest) {
        throw new ConflictException({ error: "stale", latest: newest, message: `version ${String(newest)} has been saved since this change was started; read it and make the change again` });
      }
      if (latest?.document_sha256 === hash) throw new ConflictException({ error: "unchanged", message: `this is the same as version ${String(latest.version)}; change something before saving a new version` });
      const version = newest + 1;
      if (version > MAX_VERSIONS) throw new ConflictException({ error: "version_limit", message: `an organisation can keep at most ${String(MAX_VERSIONS)} versions` });
      const row = (await c.query<Row>(
        "INSERT INTO ropa_versions (id, tenant_id, version, document_json, document_sha256, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
        [id, tenantId, version, text, hash, note ?? null, auth.actor],
      )).rows[0] as Row;
      await this.audit.append(c, tenantId, {
        actorType: auth.scopes.includes("dpo") ? "dpo" : "system", actorId: auth.actor, action: "ropa.version_created", refTable: "ropa_versions", refId: id,
        payloadSha256: sha256Hex(JSON.stringify(["saral.ropa", 1, tenantId, id, version, hash])),
      });
      return view(row);
    });
  }

  async list(tenantId: string): Promise<RopaVersionView[]> {
    return this.db.inScope({ tenantId }, async (c) => (await c.query<Row>("SELECT * FROM ropa_versions ORDER BY version DESC LIMIT $1", [LIST_LIMIT])).rows.map(view));
  }

  private async one(c: pg.PoolClient, where: "latest" | string): Promise<Row> {
    const row = (where === "latest"
      ? await c.query<Row>("SELECT * FROM ropa_versions ORDER BY version DESC LIMIT 1")
      : await c.query<Row>("SELECT * FROM ropa_versions WHERE id = $1", [where])).rows[0];
    if (row === undefined) throw new NotFoundException({ error: "not_found", message: where === "latest" ? "no record has been saved yet" : "version not found" });
    return row;
  }

  /** One version with its record, as the JSON that was stored. */
  async get(tenantId: string, which: "latest" | string): Promise<RopaVersionView & { document: unknown }> {
    return this.db.inScope({ tenantId }, async (c) => {
      const r = await this.one(c, which);
      return { ...view(r), document: JSON.parse(r.document_json) as unknown };
    });
  }
}

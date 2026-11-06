import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { sha256Hex } from "@saral/audit-chain";
import { AuditService } from "../audit/audit.service.js";
import { Database } from "../db/database.js";
import type { BuiltNotice } from "./publish-input.js";

export interface NoticeSummary {
  id: string;
  version: number;
  language: string;
  reviewStatus: string;
  canonicalSha256: string;
  publishedAt: string;
  purposeKeys: string[];
}

interface Row {
  id: string;
  version: number;
  language: string;
  review_status: string;
  canonical_sha256: string;
  published_at: Date;
  purpose_definitions: { key: string }[];
}

const view = (r: Row): NoticeSummary => ({
  id: r.id, version: r.version, language: r.language, reviewStatus: r.review_status, canonicalSha256: r.canonical_sha256,
  publishedAt: r.published_at.toISOString(), purposeKeys: r.purpose_definitions.map((d) => d.key),
});

@Injectable()
export class NoticeService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** Stores a new version of the notice for its language. A published notice never changes: an edit is a new version. */
  async publish(tenantId: string, actor: string, built: BuiltNotice): Promise<NoticeSummary> {
    const id = randomUUID();
    return this.db.inScope({ tenantId }, async (c) => {
      // One publication at a time per organisation, so two cannot be given the same version.
      await c.query("SELECT audit_append_lock($1)", [tenantId]);
      const version = ((await c.query<{ v: number }>("SELECT coalesce(max(version), 0)::int + 1 AS v FROM privacy_notices WHERE tenant_id = $1 AND language = $2", [tenantId, built.language])).rows[0] as { v: number }).v;
      const row = (
        await c.query<Row>(
          `INSERT INTO privacy_notices (id, tenant_id, version, language, canonical_text, canonical_sha256, purpose_definitions, published_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp())
           RETURNING id, version, language, review_status, canonical_sha256, published_at, purpose_definitions`,
          [id, tenantId, version, built.language, built.text, built.sha256, JSON.stringify(built.definitions)],
        )
      ).rows[0] as Row;
      await this.audit.append(c, tenantId, {
        actorType: "system", actorId: actor, action: "notice.published", refTable: "privacy_notices", refId: id,
        payloadSha256: sha256Hex(JSON.stringify(["saral.notice", 1, tenantId, id, version, built.language, built.sha256])),
      });
      return view(row);
    });
  }

  /** Newest first. The text is left out: it is public at `/v1/notices/<id>`. */
  async list(tenantId: string): Promise<NoticeSummary[]> {
    const rows = await this.db.inScope({ tenantId }, async (c) =>
      (await c.query<Row>("SELECT id, version, language, review_status, canonical_sha256, published_at, purpose_definitions FROM privacy_notices WHERE tenant_id = $1 ORDER BY published_at DESC, version DESC", [tenantId])).rows);
    return rows.map(view);
  }
}

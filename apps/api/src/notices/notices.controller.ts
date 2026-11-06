import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
import { Public } from "../auth/access.js";
import { Database } from "../db/database.js";
import { uuidParam } from "../http/validate.js";

@Controller("v1/notices")
export class NoticesController {
  constructor(private readonly db: Database) {}

  /** A published notice is public by design: its URL is what a receipt points to. Nothing about the tenant's other data is exposed. */
  @Get(":id")
  @Public()
  async get(@Param("id") rawId: string) {
    const id = uuidParam(rawId, "id");
    const row = await this.db.inScope({ publicNoticeId: id }, async (c) =>
      (await c.query<{ id: string; version: number; language: string; canonical_text: string; canonical_sha256: string; review_status: string; published_at: Date }>(
        "SELECT id, version, language, canonical_text, canonical_sha256, review_status, published_at FROM privacy_notices WHERE id = $1", [id])).rows[0]);
    if (row === undefined) throw new NotFoundException({ error: "not_found", message: "notice not found" });
    return {
      id: row.id, version: row.version, language: row.language, canonicalText: row.canonical_text,
      canonicalSha256: row.canonical_sha256, reviewStatus: row.review_status, publishedAt: row.published_at.toISOString(),
    };
  }
}

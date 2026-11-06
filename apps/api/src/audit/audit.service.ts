import { Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import { GENESIS_HASH, buildAnchor, merkleRoot, sealEntry, verifyChain, type Anchor, type ChainEntry, type ChainFailure } from "@saral/audit-chain";
import type { AuditFields } from "@saral/schemas";
import type pg from "pg";
import { Database } from "../db/database.js";
import { bad } from "../http/validate.js";
import { KEY_PROVIDER, type KeyProvider } from "../keys/key-provider.js";

type Row = {
  tenant_id: string; seq_no: string; ts: Date; actor_type: AuditFields["actorType"]; actor_id: string | null; action: string;
  ref_table: string; ref_id: string; payload_sha256: string; prev_hash: string; entry_hash: string;
  canonical_schema_version: number; hmac_schema_version: number;
};

const toEntry = (r: Row): ChainEntry => ({
  tenantId: r.tenant_id, seqNo: r.seq_no, ts: r.ts.toISOString(), actorType: r.actor_type, actorId: r.actor_id, action: r.action,
  refTable: r.ref_table, refId: r.ref_id, payloadSha256: r.payload_sha256, prevHash: r.prev_hash, entryHash: r.entry_hash,
  canonicalSchemaVersion: r.canonical_schema_version, hmacSchemaVersion: r.hmac_schema_version,
});

export interface AuditAppend {
  actorType: AuditFields["actorType"];
  actorId: string | null;
  action: string;
  refTable: string;
  refId: string;
  payloadSha256: string;
}

export type VerifyOutcome =
  | { ok: true; count: number; headHash: string; firstSeqNo: string | null; lastSeqNo: string | null; merkleRoot: string }
  | { ok: false; failure: ChainFailure; seqNo: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses `YYYY-MM-DD` as a UTC day. Throws 400 for anything else, including impossible dates. */
export function utcDay(value: unknown): { start: Date; end: Date; label: string } {
  if (typeof value !== "string" || !DATE.test(value)) throw bad("date", "must be YYYY-MM-DD");
  const start = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== value) throw bad("date", "is not a real date");
  return { start, end: new Date(start.getTime() + 86_400_000), label: value };
}

@Injectable()
export class AuditService {
  constructor(
    private readonly db: Database,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
  ) {}

  /**
   * Appends one entry inside the caller's transaction: lock the tenant's chain, read its head, seal, insert.
   * The lock is held until the caller commits, so concurrent appends for a tenant queue up and never fork the chain.
   * Timestamps never go backwards, even if the clock does.
   */
  async append(c: pg.PoolClient, tenantId: string, entry: AuditAppend): Promise<ChainEntry> {
    await c.query("SELECT audit_append_lock($1)", [tenantId]);
    const head = (await c.query<Row>("SELECT * FROM consent_audit_log ORDER BY seq_no DESC LIMIT 1")).rows[0];
    const version = this.keys.currentAuditKeyVersion;
    const key = this.keys.auditHmacKey(version);
    if (key === undefined) throw new Error(`no audit key for version ${String(version)}`);
    const ts = new Date(Math.max(Date.now(), head ? head.ts.getTime() : 0)).toISOString();
    const sealed = sealEntry(
      { tenantId, seqNo: String(BigInt(head?.seq_no ?? "0") + 1n), ts, ...entry },
      head?.entry_hash ?? GENESIS_HASH,
      key,
      { hmacSchemaVersion: version },
    );
    await c.query(
      `INSERT INTO consent_audit_log (tenant_id, seq_no, ts, actor_type, actor_id, action, ref_table, ref_id, payload_sha256, prev_hash, entry_hash, canonical_schema_version, hmac_schema_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [sealed.tenantId, sealed.seqNo, sealed.ts, sealed.actorType, sealed.actorId, sealed.action, sealed.refTable, sealed.refId, sealed.payloadSha256, sealed.prevHash, sealed.entryHash, sealed.canonicalSchemaVersion, sealed.hmacSchemaVersion],
    );
    return sealed;
  }

  /** A verify request loads its entries into memory, so it is limited. Larger chains are verified one UTC day at a time. */
  maxEntries = 100_000;

  /** The entries of the tenant (all, or one UTC day) plus the entry just before the first one. */
  private async load(tenantId: string, day?: { start: Date; end: Date }): Promise<{ entries: ChainEntry[]; previous: ChainEntry | undefined }> {
    return this.db.inScope({ tenantId }, async (c) => {
      const counted =
        day === undefined
          ? await c.query<{ n: number }>("SELECT count(*)::int AS n FROM consent_audit_log")
          : await c.query<{ n: number }>("SELECT count(*)::int AS n FROM consent_audit_log WHERE ts >= $1 AND ts < $2", [day.start, day.end]);
      if ((counted.rows[0]?.n ?? 0) > this.maxEntries) {
        throw new UnprocessableEntityException({
          error: "too_large",
          message: `more than ${String(this.maxEntries)} entries; verify one UTC day at a time with ?date=YYYY-MM-DD`,
        });
      }
      const rows =
        day === undefined
          ? (await c.query<Row>("SELECT * FROM consent_audit_log ORDER BY seq_no")).rows
          : (await c.query<Row>("SELECT * FROM consent_audit_log WHERE ts >= $1 AND ts < $2 ORDER BY seq_no", [day.start, day.end])).rows;
      const entries = rows.map(toEntry);
      const first = rows[0];
      let previous: ChainEntry | undefined;
      if (first !== undefined && first.seq_no !== "1") {
        const prev = await c.query<Row>("SELECT * FROM consent_audit_log WHERE seq_no = $1", [String(BigInt(first.seq_no) - 1n)]);
        previous = prev.rows[0] ? toEntry(prev.rows[0]) : undefined;
      }
      return { entries, previous };
    });
  }

  private check(entries: ChainEntry[], previous: ChainEntry | undefined) {
    return verifyChain(entries, (v) => this.keys.auditHmacKey(v), {
      ...(previous ? { startPrevHash: previous.entryHash, startSeqNo: previous.seqNo, startHmacSchemaVersion: previous.hmacSchemaVersion } : {}),
    });
  }

  async verify(tenantId: string, date?: string): Promise<VerifyOutcome> {
    const day = date === undefined ? undefined : utcDay(date);
    const { entries, previous } = await this.load(tenantId, day);
    const result = this.check(entries, previous);
    if (!result.ok) return { ok: false, failure: result.failure, seqNo: result.seqNo };
    return {
      ok: true,
      count: result.count,
      headHash: result.headHash,
      firstSeqNo: entries[0]?.seqNo ?? null,
      lastSeqNo: result.lastSeqNo,
      merkleRoot: merkleRoot(entries.map((e) => e.entryHash)),
    };
  }

  /** The anchor for one UTC day, or null if there were no entries. A chain that does not verify gives no anchor. */
  async anchor(tenantId: string, date: string): Promise<{ anchor: Anchor } | { failure: ChainFailure; seqNo: string } | null> {
    const day = utcDay(date);
    const { entries, previous } = await this.load(tenantId, day);
    if (entries.length === 0) return null;
    const result = this.check(entries, previous);
    if (!result.ok) return { failure: result.failure, seqNo: result.seqNo };
    return { anchor: buildAnchor(tenantId, day.label, entries) };
  }
}

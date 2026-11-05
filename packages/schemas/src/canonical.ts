/**
 * Canonical strings, version 1. FROZEN CONTRACT (docs/adr/0002-canonical-string-v1.md).
 *
 * A canonical string is `JSON.stringify` of a fixed-order array of validated values. JSON
 * escapes every delimiter-like character, so two different records can never produce the same
 * string. Never change the output of version 1: add version 2 next to it and keep v1 readable.
 */

export const SUPPORTED_CANONICAL_VERSIONS: readonly number[] = [1];

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalError";
  }
}

export type ActorType = "principal" | "dpo" | "system";
export type ConsentStatus = "granted" | "withdrawn" | "expired";
export type CollectionMethod = "web_sdk" | "api" | "dpo_entry";

/** The fields of one audit-log entry that are covered by the hash chain. */
export interface AuditFields {
  tenantId: string;
  /** Decimal string, because the database column is a bigint. */
  seqNo: string;
  /** `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC, milliseconds). */
  ts: string;
  actorType: ActorType;
  actorId: string | null;
  action: string;
  refTable: string;
  refId: string;
  /** SHA-256 (lowercase hex) of the canonical string of the record the entry refers to. */
  payloadSha256: string;
}

export interface PurposeGrant {
  key: string;
  granted: boolean;
  retentionDays: number;
}

/** The fields of one consent record that are covered by its content hash. */
export interface ConsentFields {
  tenantId: string;
  consentId: string;
  /** Pseudonymous principal id (never a phone number or email). */
  principalId: string;
  noticeId: string;
  noticeSha256: string;
  purposes: PurposeGrant[];
  status: ConsentStatus;
  grantedAt: string;
  withdrawnAt: string | null;
  collectionMethod: CollectionMethod;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEQ_NO = /^(0|[1-9][0-9]{0,18})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ACTION = /^[a-z]+(\.[a-z_]+)+$/;
const TABLE = /^[a-z_]+$/;
const PURPOSE_KEY = /^[a-z][a-z0-9_]{0,62}$/;
const ACTOR_TYPES: readonly string[] = ["principal", "dpo", "system"];
const STATUSES: readonly string[] = ["granted", "withdrawn", "expired"];
const METHODS: readonly string[] = ["web_sdk", "api", "dpo_entry"];
const MAX_BIGINT = 9223372036854775807n;
const MAX_RETENTION_DAYS = 36500;
const MAX_ACTOR_ID = 128;

function fail(field: string, why: string): never {
  throw new CanonicalError(`${field}: ${why}`);
}

function uuid(field: string, v: unknown): string {
  if (typeof v !== "string" || !UUID.test(v)) fail(field, "must be a lowercase UUID");
  return v;
}

function sha256(field: string, v: unknown): string {
  if (typeof v !== "string" || !SHA256_HEX.test(v)) fail(field, "must be 64 lowercase hex characters");
  return v;
}

function timestamp(field: string, v: unknown): string {
  if (typeof v !== "string" || !TIMESTAMP.test(v)) {
    fail(field, "must be YYYY-MM-DDTHH:mm:ss.sssZ");
  }
  const d = new Date(v);
  // Date rolls 2026-02-31 over to March, so a round trip catches impossible dates.
  if (Number.isNaN(d.getTime()) || d.toISOString() !== v) fail(field, "is not a real instant");
  return v;
}

function oneOf<T extends string>(field: string, v: unknown, allowed: readonly string[]): T {
  if (typeof v !== "string" || !allowed.includes(v)) {
    fail(field, `must be one of ${allowed.join(", ")}`);
  }
  return v as T;
}

function seqNo(v: unknown): string {
  if (typeof v !== "string" || !SEQ_NO.test(v)) fail("seqNo", "must be a decimal string without leading zeros");
  if (BigInt(v) > MAX_BIGINT) fail("seqNo", "exceeds the bigint range");
  return v;
}

function checkVersion(version: number): void {
  if (!SUPPORTED_CANONICAL_VERSIONS.includes(version)) {
    fail("version", `unsupported canonical schema version ${String(version)}`);
  }
}

/** Canonical string of one audit entry. The hash chain is computed over this string. */
export function canonicalAuditEntry(fields: AuditFields, version = 1): string {
  checkVersion(version);
  const actorId = fields.actorId;
  if (actorId !== null && (typeof actorId !== "string" || actorId.length < 1 || actorId.length > MAX_ACTOR_ID)) {
    fail("actorId", `must be null or 1 to ${String(MAX_ACTOR_ID)} characters`);
  }
  if (typeof fields.action !== "string" || !ACTION.test(fields.action)) {
    fail("action", "must look like consent.granted");
  }
  if (typeof fields.refTable !== "string" || !TABLE.test(fields.refTable)) {
    fail("refTable", "must be lowercase letters and underscores");
  }
  return JSON.stringify([
    "saral.audit",
    version,
    uuid("tenantId", fields.tenantId),
    seqNo(fields.seqNo),
    timestamp("ts", fields.ts),
    oneOf<ActorType>("actorType", fields.actorType, ACTOR_TYPES),
    actorId,
    fields.action,
    fields.refTable,
    uuid("refId", fields.refId),
    sha256("payloadSha256", fields.payloadSha256),
  ]);
}

function purposes(list: unknown): [string, boolean, number][] {
  if (!Array.isArray(list) || list.length === 0) fail("purposes", "must be a non-empty array");
  const seen = new Set<string>();
  const rows: [string, boolean, number][] = [];
  for (const p of list as PurposeGrant[]) {
    if (typeof p?.key !== "string" || !PURPOSE_KEY.test(p.key)) {
      fail("purposes.key", "must match [a-z][a-z0-9_]{0,62}");
    }
    if (seen.has(p.key)) fail("purposes.key", `duplicate key ${p.key}`);
    seen.add(p.key);
    if (typeof p.granted !== "boolean") fail("purposes.granted", "must be a boolean");
    if (!Number.isInteger(p.retentionDays) || p.retentionDays < 0 || p.retentionDays > MAX_RETENTION_DAYS) {
      fail("purposes.retentionDays", `must be an integer from 0 to ${String(MAX_RETENTION_DAYS)}`);
    }
    rows.push([p.key, p.granted, p.retentionDays]);
  }
  // Plain code-unit order, never locale order, so every runtime sorts the same way.
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return rows;
}

/** Canonical string of one consent record. Its SHA-256 becomes `payloadSha256` of the audit entry. */
export function canonicalConsentRecord(fields: ConsentFields, version = 1): string {
  checkVersion(version);
  const status = oneOf<ConsentStatus>("status", fields.status, STATUSES);
  const withdrawnAt = fields.withdrawnAt === null ? null : timestamp("withdrawnAt", fields.withdrawnAt);
  if ((status === "withdrawn") !== (withdrawnAt !== null)) {
    fail("withdrawnAt", "must be set exactly when status is withdrawn");
  }
  return JSON.stringify([
    "saral.consent",
    version,
    uuid("tenantId", fields.tenantId),
    uuid("consentId", fields.consentId),
    uuid("principalId", fields.principalId),
    uuid("noticeId", fields.noticeId),
    sha256("noticeSha256", fields.noticeSha256),
    purposes(fields.purposes),
    status,
    timestamp("grantedAt", fields.grantedAt),
    withdrawnAt,
    oneOf<CollectionMethod>("collectionMethod", fields.collectionMethod, METHODS),
  ]);
}

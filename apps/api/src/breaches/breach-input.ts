import { bad } from "../http/validate.js";

export const NATURES = ["confidentiality", "integrity", "availability"] as const;
export type Nature = (typeof NATURES)[number];

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const SKEW_MS = 5 * 60_000;
const TEN_YEARS_MS = 10 * 366 * 86_400_000;
const MAX_PEOPLE = 1_000_000_000;

const onlyKeys = (body: Record<string, unknown>, allowed: readonly string[]): void => {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw bad(key, "is not part of this form");
};

/** Trimmed text of 1 to `max` characters. */
export function text(v: unknown, field: string, max: number): string {
  if (typeof v !== "string") throw bad(field, `must be text of 1 to ${String(max)} characters`);
  const t = v.trim();
  if (t.length < 1 || t.length > max) throw bad(field, `must be text of 1 to ${String(max)} characters`);
  return t;
}

/** A full ISO 8601 time with its zone, not in the future (a few minutes of clock difference allowed) and not more than ten years old. */
export function instant(v: unknown, field: string, now: Date, opts: { notBefore?: Date } = {}): Date {
  if (typeof v !== "string" || !ISO.test(v)) throw bad(field, "must be a date and time with its time zone, such as 2026-11-06T09:00:00Z");
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw bad(field, "is not a real date and time");
  if (d.getTime() > now.getTime() + SKEW_MS) throw bad(field, "cannot be in the future");
  if (d.getTime() < now.getTime() - TEN_YEARS_MS) throw bad(field, "cannot be more than ten years ago");
  if (opts.notBefore !== undefined && d.getTime() < opts.notBefore.getTime()) throw bad(field, "cannot be before the breach was found");
  return d;
}

function whole(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_PEOPLE) throw bad(field, `must be a whole number from 0 to ${String(MAX_PEOPLE)}`);
  return v;
}

function nature(v: unknown): Nature[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > NATURES.length) throw bad("nature", `must list 1 to ${String(NATURES.length)} of: ${NATURES.join(", ")}`);
  if (!v.every((n): n is Nature => NATURES.includes(n as Nature))) throw bad("nature", `unknown value; use: ${NATURES.join(", ")}`);
  if (new Set(v).size !== v.length) throw bad("nature", "a value is listed twice");
  return NATURES.filter((n) => v.includes(n));
}

function categories(v: unknown): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 20) throw bad("dataCategories", "must list 1 to 20 kinds of personal data");
  const out = v.map((x) => text(x, "dataCategories", 100));
  if (new Set(out.map((x) => x.toLowerCase())).size !== out.length) throw bad("dataCategories", "a kind is listed twice");
  return out;
}

export interface ReportInput {
  title: string;
  description: string;
  discoveredAt: Date;
  occurredAt: Date | null;
  nature: Nature[];
  dataCategories: string[];
  approxPrincipals: number | null;
  likelyConsequences: string;
  measuresTaken: string;
}

const REPORT_KEYS = ["title", "description", "discoveredAt", "occurredAt", "nature", "dataCategories", "approxPrincipalsAffected", "likelyConsequences", "measuresTaken"] as const;

function occurred(v: unknown, now: Date): Date | null {
  return v === undefined || v === null ? null : instant(v, "occurredAt", now);
}
function approx(v: unknown): number | null {
  return v === undefined || v === null ? null : whole(v, "approxPrincipalsAffected");
}

/** What is needed to report a breach. The time it happened and the number of people are optional. */
export function parseReport(body: Record<string, unknown>, now: Date): ReportInput {
  onlyKeys(body, REPORT_KEYS);
  const discoveredAt = instant(body.discoveredAt, "discoveredAt", now);
  const occurredAt = occurred(body.occurredAt, now);
  if (occurredAt !== null && occurredAt.getTime() > discoveredAt.getTime()) throw bad("occurredAt", "cannot be after the time it was found");
  return {
    title: text(body.title, "title", 120),
    description: text(body.description, "description", 4000),
    discoveredAt,
    occurredAt,
    nature: nature(body.nature),
    dataCategories: categories(body.dataCategories),
    approxPrincipals: approx(body.approxPrincipalsAffected),
    likelyConsequences: text(body.likelyConsequences, "likelyConsequences", 2000),
    measuresTaken: text(body.measuresTaken, "measuresTaken", 2000),
  };
}

/** A correction: any of the report's fields, at least one. `null` clears the time it happened or the number of people. */
export function parsePatch(body: Record<string, unknown>, now: Date): Partial<ReportInput> {
  onlyKeys(body, REPORT_KEYS);
  if (Object.keys(body).length === 0) throw bad("body", "send at least one field to change");
  const out: Partial<ReportInput> = {};
  if ("title" in body) out.title = text(body.title, "title", 120);
  if ("description" in body) out.description = text(body.description, "description", 4000);
  if ("discoveredAt" in body) out.discoveredAt = instant(body.discoveredAt, "discoveredAt", now);
  if ("occurredAt" in body) out.occurredAt = occurred(body.occurredAt, now);
  if ("nature" in body) out.nature = nature(body.nature);
  if ("dataCategories" in body) out.dataCategories = categories(body.dataCategories);
  if ("approxPrincipalsAffected" in body) out.approxPrincipals = approx(body.approxPrincipalsAffected);
  if ("likelyConsequences" in body) out.likelyConsequences = text(body.likelyConsequences, "likelyConsequences", 2000);
  if ("measuresTaken" in body) out.measuresTaken = text(body.measuresTaken, "measuresTaken", 2000);
  return out;
}

export function parseBoardNotified(body: Record<string, unknown>, now: Date, discoveredAt: Date): { notifiedAt: Date; reference: string } {
  onlyKeys(body, ["notifiedAt", "reference"]);
  return { notifiedAt: instant(body.notifiedAt, "notifiedAt", now, { notBefore: discoveredAt }), reference: text(body.reference, "reference", 200) };
}

export function parsePrincipals(body: Record<string, unknown>): { how: string; count: number } {
  onlyKeys(body, ["how", "count"]);
  return { how: text(body.how, "how", 1000), count: whole(body.count, "count") };
}

export function parseClose(body: Record<string, unknown>): { note: string } {
  onlyKeys(body, ["note"]);
  return { note: text(body.note, "note", 2000) };
}

/** What a sign-off carries: the hashes of the two drafts as the officer was shown them. */
export function parseSignOff(body: Record<string, unknown>): { boardSha256: string; principalSha256: string } {
  onlyKeys(body, ["boardSha256", "principalSha256"]);
  const hash = (v: unknown, field: string): string => {
    if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) throw bad(field, "must be the 64 hexadecimal characters (lowercase) that came with the draft you read");
    return v;
  };
  return { boardSha256: hash(body.boardSha256, "boardSha256"), principalSha256: hash(body.principalSha256, "principalSha256") };
}

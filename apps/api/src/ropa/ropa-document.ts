/**
 * The record of processing an organisation keeps (docs/PLAN.md P1 item 8): who it is, when it was last reviewed, and one entry for each
 * thing it does with personal data. This module checks a record and writes it in one canonical form, which is what is stored and hashed.
 * It does not know about HTTP; the controller turns a RopaError into a 400.
 */
export class RopaError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

export const SCHEMA = "saral.ropa/1";
export const LEGAL_BASES = ["consent", "legitimate_use", "unsure"] as const;
export const SOURCES = ["directly_from_person", "from_third_party", "generated_by_us", "mixed"] as const;
export const RECIPIENT_ROLES = ["processor", "third_party"] as const;
export const SIGNIFICANT = ["yes", "no", "unsure"] as const;
export const SECURITY_MEASURES = ["encryption_at_rest", "encryption_in_transit", "access_control", "multi_factor", "logging", "backups", "pseudonymisation", "physical_security"] as const;
export const MAX_ACTIVITIES = 30;
/**
 * The most a record may hold, in bytes of its canonical text: 90 KiB, which is hundreds of activities of ordinary length and always fits in
 * the API's 100 KB request limit with the rest of the request. The database allows 256 KiB; this check is on bytes, which is never less
 * strict than on characters.
 */
export const MAX_BYTES = 90 * 1024;

export interface Recipient {
  name: string;
  role: (typeof RECIPIENT_ROLES)[number];
  country: string;
}

export interface Activity {
  name: string;
  description: string;
  purposes: string[];
  legalBasis: (typeof LEGAL_BASES)[number];
  principals: string[];
  personalData: string[];
  involvesChildren: boolean;
  source: (typeof SOURCES)[number];
  recipients: Recipient[];
  crossBorder: boolean;
  transferCountries: string[];
  retention: string;
  securityMeasures: (typeof SECURITY_MEASURES)[number][];
  otherMeasures?: string;
  storage: string;
  owner: string;
}

export interface RopaDocument {
  schema: typeof SCHEMA;
  organisation: {
    name: string;
    address: string;
    contactName: string;
    contactEmail: string;
    website?: string;
    sector: string;
    significantDataFiduciary: (typeof SIGNIFICANT)[number];
  };
  review: { lastReviewedOn: string; nextReviewDue?: string };
  activities: Activity[];
  notes?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COUNTRY = /^[A-Z]{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new RopaError(`${path}${k}`, "is not part of the record");
}

function text(v: unknown, field: string, max: number): string {
  if (typeof v !== "string") throw new RopaError(field, `must be text of 1 to ${String(max)} characters`);
  const t = v.trim();
  if (t.length < 1 || t.length > max) throw new RopaError(field, `must be text of 1 to ${String(max)} characters`);
  return t;
}

function optionalText(v: unknown, field: string, max: number): string | undefined {
  return v === undefined ? undefined : text(v, field, max);
}

function list(v: unknown, field: string, min: number, max: number, itemMax: number, what: string): string[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) throw new RopaError(field, `must list ${min === 0 ? "up to" : `${String(min)} to`} ${String(max)} ${what}`);
  const out = v.map((x) => text(x, field, itemMax));
  if (new Set(out.map((x) => x.toLowerCase())).size !== out.length) throw new RopaError(field, "has an entry listed twice");
  return out;
}

function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) throw new RopaError(field, `must be one of: ${allowed.join(", ")}`);
  return v as T;
}

function bool(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw new RopaError(field, "must be true or false");
  return v;
}

function realDay(v: unknown, field: string): { text: string; at: number } {
  if (typeof v !== "string" || !DAY.test(v)) throw new RopaError(field, "must be a date written YYYY-MM-DD");
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new RopaError(field, "is not a real date");
  return { text: v, at: d.getTime() };
}

function website(v: unknown, field: string): string | undefined {
  if (v === undefined) return undefined;
  const s = text(v, field, 300);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new RopaError(field, "must be an https address");
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "") throw new RopaError(field, "must be an https address without a user name or password");
  return s;
}

function country(v: unknown, field: string): string {
  if (typeof v !== "string" || !COUNTRY.test(v)) throw new RopaError(field, "must be a two-letter country code in capitals, such as IN");
  return v;
}

function activity(raw: unknown, i: number): Activity {
  const at = `activities[${String(i)}]`;
  if (!isObject(raw)) throw new RopaError(at, "must be an object");
  onlyKeys(raw, ["name", "description", "purposes", "legalBasis", "principals", "personalData", "involvesChildren", "source", "recipients", "crossBorder", "transferCountries", "retention", "securityMeasures", "otherMeasures", "storage", "owner"], `${at}.`);
  const name = text(raw.name, `${at}.name`, 120);
  const description = text(raw.description, `${at}.description`, 1000);
  const purposes = list(raw.purposes, `${at}.purposes`, 1, 10, 200, "purposes");
  const legalBasis = oneOf(raw.legalBasis, `${at}.legalBasis`, LEGAL_BASES);
  const principals = list(raw.principals, `${at}.principals`, 1, 10, 100, "kinds of people");
  const personalData = list(raw.personalData, `${at}.personalData`, 1, 30, 100, "kinds of personal data");
  const involvesChildren = bool(raw.involvesChildren, `${at}.involvesChildren`);
  const source = oneOf(raw.source, `${at}.source`, SOURCES);
  if (!Array.isArray(raw.recipients) || raw.recipients.length > 20) throw new RopaError(`${at}.recipients`, "must list up to 20 recipients");
  const recipients = raw.recipients.map((r: unknown, k): Recipient => {
    const rp = `${at}.recipients[${String(k)}]`;
    if (!isObject(r)) throw new RopaError(rp, "must be an object");
    onlyKeys(r, ["name", "role", "country"], `${rp}.`);
    return { name: text(r.name, `${rp}.name`, 120), role: oneOf(r.role, `${rp}.role`, RECIPIENT_ROLES), country: country(r.country, `${rp}.country`) };
  });
  const crossBorder = bool(raw.crossBorder, `${at}.crossBorder`);
  if (!Array.isArray(raw.transferCountries)) throw new RopaError(`${at}.transferCountries`, "must be a list of country codes");
  const transferCountries = raw.transferCountries.map((c: unknown) => country(c, `${at}.transferCountries`));
  if (new Set(transferCountries).size !== transferCountries.length) throw new RopaError(`${at}.transferCountries`, "has a country listed twice");
  if (crossBorder && transferCountries.length === 0) throw new RopaError(`${at}.transferCountries`, "must name the countries when data is transferred abroad");
  if (!crossBorder && transferCountries.length > 0) throw new RopaError(`${at}.transferCountries`, "must be empty when data is not transferred abroad");
  const retention = text(raw.retention, `${at}.retention`, 300);
  if (!Array.isArray(raw.securityMeasures) || raw.securityMeasures.length > SECURITY_MEASURES.length) throw new RopaError(`${at}.securityMeasures`, `must list some of: ${SECURITY_MEASURES.join(", ")}`);
  const securityMeasures = raw.securityMeasures.map((m: unknown) => oneOf(m, `${at}.securityMeasures`, SECURITY_MEASURES));
  if (new Set(securityMeasures).size !== securityMeasures.length) throw new RopaError(`${at}.securityMeasures`, "has a measure listed twice");
  const otherMeasures = optionalText(raw.otherMeasures, `${at}.otherMeasures`, 300);
  if (securityMeasures.length === 0 && otherMeasures === undefined) throw new RopaError(`${at}.securityMeasures`, "must list at least one measure, or describe others in otherMeasures");
  const storage = text(raw.storage, `${at}.storage`, 200);
  const owner = text(raw.owner, `${at}.owner`, 120);
  return {
    name, description, purposes, legalBasis, principals, personalData, involvesChildren, source, recipients, crossBorder, transferCountries, retention,
    securityMeasures: SECURITY_MEASURES.filter((m) => securityMeasures.includes(m)), ...(otherMeasures === undefined ? {} : { otherMeasures }), storage, owner,
  };
}

/** Checks a record. `now` is when it is being saved: a review cannot be dated after today. Throws RopaError naming the field. */
export function parseRopaDocument(raw: unknown, now: Date = new Date()): RopaDocument {
  if (!isObject(raw)) throw new RopaError("body", "must be a JSON object");
  onlyKeys(raw, ["schema", "organisation", "review", "activities", "notes"], "");
  if (raw.schema !== SCHEMA) throw new RopaError("schema", `must be ${SCHEMA}`);
  if (!isObject(raw.organisation)) throw new RopaError("organisation", "must be an object");
  const o = raw.organisation;
  onlyKeys(o, ["name", "address", "contactName", "contactEmail", "website", "sector", "significantDataFiduciary"], "organisation.");
  const email = text(o.contactEmail, "organisation.contactEmail", 254);
  if (!EMAIL.test(email)) throw new RopaError("organisation.contactEmail", "must be an email address");
  const site = website(o.website, "organisation.website");
  const organisation: RopaDocument["organisation"] = {
    name: text(o.name, "organisation.name", 200), address: text(o.address, "organisation.address", 500), contactName: text(o.contactName, "organisation.contactName", 120),
    contactEmail: email, ...(site === undefined ? {} : { website: site }), sector: text(o.sector, "organisation.sector", 120),
    significantDataFiduciary: oneOf(o.significantDataFiduciary, "organisation.significantDataFiduciary", SIGNIFICANT),
  };
  if (!isObject(raw.review)) throw new RopaError("review", "must be an object");
  onlyKeys(raw.review, ["lastReviewedOn", "nextReviewDue"], "review.");
  const last = realDay(raw.review.lastReviewedOn, "review.lastReviewedOn");
  if (last.at > now.getTime() + 86_400_000) throw new RopaError("review.lastReviewedOn", "cannot be in the future");
  let next: { text: string; at: number } | undefined;
  if (raw.review.nextReviewDue !== undefined) {
    next = realDay(raw.review.nextReviewDue, "review.nextReviewDue");
    if (next.at < last.at) throw new RopaError("review.nextReviewDue", "cannot be before the last review");
  }
  if (!Array.isArray(raw.activities) || raw.activities.length < 1 || raw.activities.length > MAX_ACTIVITIES) throw new RopaError("activities", `must list 1 to ${String(MAX_ACTIVITIES)} processing activities`);
  const activities = raw.activities.map(activity);
  const names = activities.map((a) => a.name.toLowerCase());
  names.forEach((n, i) => {
    if (names.indexOf(n) !== i) throw new RopaError(`activities[${String(i)}].name`, "is the name of another activity");
  });
  const notes = optionalText(raw.notes, "notes", 2000);
  const doc: RopaDocument = { schema: SCHEMA, organisation, review: { lastReviewedOn: last.text, ...(next === undefined ? {} : { nextReviewDue: next.text }) }, activities, ...(notes === undefined ? {} : { notes }) };
  if (Buffer.byteLength(canonicalRopa(doc), "utf8") > MAX_BYTES) throw new RopaError("body", "is larger than 90 KiB: shorten the longest answers or remove an activity");
  return doc;
}

/** The record as it is stored and hashed: fixed key order, compact JSON, optional parts left out when not given. */
export function canonicalRopa(d: RopaDocument): string {
  return JSON.stringify(d);
}

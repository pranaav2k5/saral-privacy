import { ApiError, type RopaActivity, type RopaDocument, type RopaLegalBasis, type RopaMeasure, type RopaRecipientRole, type RopaSource, type RopaYesNoUnsure } from "./api";
import { dayLabel } from "./format";

/** The record is at most this many bytes of its compact JSON text, which is what the server checks. */
const MAX_BYTES = 90 * 1024;
const MAX_ACTIVITIES = 30;
const DAY_MS = 86_400_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COUNTRY = /^[A-Z]{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const LEGAL_BASIS_WORDS: Record<RopaLegalBasis, string> = {
  consent: "The person agreed (consent)",
  legitimate_use: "A use the law allows without asking (legitimate use)",
  unsure: "Not sure yet",
};
export const SOURCE_WORDS: Record<RopaSource, string> = {
  directly_from_person: "Directly from the person",
  from_third_party: "From someone else",
  generated_by_us: "Made by the organisation itself",
  mixed: "More than one of these",
};
export const ROLE_WORDS: Record<RopaRecipientRole, string> = {
  processor: "Works for us and follows our instructions (a processor)",
  third_party: "Decides for itself what to do with it (a third party)",
};
export const FIDUCIARY_WORDS: Record<RopaYesNoUnsure, string> = { yes: "Yes", no: "No", unsure: "Not sure" };
export const MEASURE_WORDS: Record<RopaMeasure, string> = {
  encryption_at_rest: "Stored data is encrypted",
  encryption_in_transit: "Data is encrypted when it is sent",
  access_control: "Only the people who need it can open it",
  multi_factor: "Signing in needs a second step",
  logging: "Who opened what is recorded",
  backups: "Backups are kept",
  pseudonymisation: "Names are replaced by codes where possible",
  physical_security: "Paper and devices are kept locked up",
};
/** The order a record keeps its measures in, which is the order the server stores them. */
const MEASURES = Object.keys(MEASURE_WORDS) as RopaMeasure[];

export interface RecipientForm {
  name: string;
  role: "" | RopaRecipientRole;
  /** Two letters, such as `IN`. Small letters are accepted and made capitals. */
  country: string;
}

export interface ActivityForm {
  name: string;
  description: string;
  /** One on each line. */
  purposes: string;
  legalBasis: "" | RopaLegalBasis;
  principals: string;
  personalData: string;
  /** Left unanswered until the person chooses, so a record never says "no" on their behalf. */
  involvesChildren: "" | "yes" | "no";
  source: "" | RopaSource;
  recipients: RecipientForm[];
  crossBorder: "" | "yes" | "no";
  /** Country codes, separated by commas, spaces or new lines. */
  transferCountries: string;
  retention: string;
  securityMeasures: Record<RopaMeasure, boolean>;
  otherMeasures: string;
  storage: string;
  owner: string;
}

export interface RopaForm {
  organisation: {
    name: string;
    address: string;
    contactName: string;
    contactEmail: string;
    website: string;
    sector: string;
    significantDataFiduciary: "" | RopaYesNoUnsure;
  };
  /** `YYYY-MM-DD`, as a date box holds it. */
  lastReviewedOn: string;
  nextReviewDue: string;
  activities: ActivityForm[];
  notes: string;
}

export interface Problem {
  field: string;
  message: string;
}
export type Built<T> = { ok: true; request: T } | { ok: false; problems: Problem[] };

const noMeasures = (): Record<RopaMeasure, boolean> => Object.fromEntries(MEASURES.map((m) => [m, false])) as Record<RopaMeasure, boolean>;

export const emptyActivityForm = (): ActivityForm => ({
  name: "", description: "", purposes: "", legalBasis: "", principals: "", personalData: "", involvesChildren: "", source: "", recipients: [], crossBorder: "", transferCountries: "",
  retention: "", securityMeasures: noMeasures(), otherMeasures: "", storage: "", owner: "",
});

export const emptyRopaForm = (): RopaForm => ({
  organisation: { name: "", address: "", contactName: "", contactEmail: "", website: "", sector: "", significantDataFiduciary: "" },
  lastReviewedOn: "", nextReviewDue: "", activities: [emptyActivityForm()], notes: "",
});

const yesNo = (b: boolean): "yes" | "no" => (b ? "yes" : "no");

function formFromActivity(a: RopaActivity): ActivityForm {
  return {
    name: a.name, description: a.description, purposes: a.purposes.join("\n"), legalBasis: a.legalBasis, principals: a.principals.join("\n"), personalData: a.personalData.join("\n"),
    involvesChildren: yesNo(a.involvesChildren), source: a.source, recipients: a.recipients.map((r) => ({ ...r })), crossBorder: yesNo(a.crossBorder), transferCountries: a.transferCountries.join(", "),
    retention: a.retention, securityMeasures: Object.fromEntries(MEASURES.map((m) => [m, a.securityMeasures.includes(m)])) as Record<RopaMeasure, boolean>,
    otherMeasures: a.otherMeasures ?? "", storage: a.storage, owner: a.owner,
  };
}

/** The form for changing a saved record: every answer filled in as it was saved. */
export function formFromRopa(d: RopaDocument): RopaForm {
  return {
    organisation: { ...d.organisation, website: d.organisation.website ?? "" },
    lastReviewedOn: d.review.lastReviewedOn, nextReviewDue: d.review.nextReviewDue ?? "", activities: d.activities.map(formFromActivity), notes: d.notes ?? "",
  };
}

/** A date as the reader's own calendar day, `YYYY-MM-DD`. */
const localDay = (d: Date): string => `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const isRealDay = (v: string): boolean => {
  if (!DAY.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
/** Bytes in the UTF-8 text of a string. Written out so it does not depend on the browser or test environment having `TextEncoder`. */
const utf8Length = (s: string): number => {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
};
const lines = (v: string): string[] => v.split("\n").map((x) => x.trim()).filter((x) => x !== "");
const repeats = (xs: readonly string[]): boolean => new Set(xs.map((x) => x.toLowerCase())).size !== xs.length;

function checkedLines(raw: string, field: string, label: string, min: number, max: number, itemMax: number, add: (field: string, message: string) => void): string[] {
  const items = lines(raw);
  if (items.length < min) add(field, `${label}: list at least ${String(min)}, one on each line.`);
  else if (items.length > max) add(field, `${label}: list at most ${String(max)}.`);
  else if (items.some((x) => x.length > itemMax)) add(field, `${label}: keep each one to at most ${String(itemMax)} characters.`);
  else if (repeats(items)) add(field, `${label}: something is listed twice.`);
  return items;
}

function checkedText(raw: string, field: string, label: string, max: number, add: (field: string, message: string) => void): string {
  const t = raw.trim();
  if (t === "") add(field, `${label}: fill this in.`);
  else if (t.length > max) add(field, `${label}: use at most ${String(max)} characters.`);
  return t;
}

/** Splits typed country codes, and makes small letters capitals. */
const countryCodes = (v: string): string[] => v.split(/[\s,;]+/).filter((x) => x !== "").map((x) => x.toUpperCase());

function buildActivity(f: ActivityForm, i: number, problems: Problem[]): RopaActivity | undefined {
  const start = problems.length;
  const named = f.name.trim();
  const who = named === "" ? `Activity ${String(i + 1)}` : `Activity ${String(i + 1)} (${named})`;
  const at = `activities[${String(i)}]`;
  const add = (field: string, message: string) => problems.push({ field: `${at}.${field}`, message: `${who}: ${message}` });
  // A problem's words start with the question they are about, so the activity's name comes first and the question after it.
  const text = (raw: string, field: string, label: string, max: number) => checkedText(raw, field, label, max, add);
  const list = (raw: string, field: string, label: string, min: number, max: number, itemMax: number) => checkedLines(raw, field, label, min, max, itemMax, add);

  const name = text(f.name, "name", "Name of the activity", 120);
  const description = text(f.description, "description", "What the organisation does", 1000);
  const purposes = list(f.purposes, "purposes", "Why it is done", 1, 10, 200);
  if (f.legalBasis === "") add("legalBasis", "Choose the reason it is allowed.");
  const principals = list(f.principals, "principals", "Whose data it is", 1, 10, 100);
  const personalData = list(f.personalData, "personalData", "What data is kept", 1, 30, 100);
  if (f.involvesChildren === "") add("involvesChildren", "Say whether the data of children is involved.");
  if (f.source === "") add("source", "Choose where the data comes from.");

  const recipients: RopaActivity["recipients"] = [];
  if (f.recipients.length > 20) add("recipients", "list at most 20 recipients.");
  f.recipients.forEach((r, k) => {
    const blank = r.name.trim() === "" && r.role === "" && r.country.trim() === "";
    if (blank) return;
    const country = r.country.trim().toUpperCase();
    const rn = r.name.trim();
    if (rn === "" || rn.length > 120 || r.role === "" || !COUNTRY.test(country)) {
      add(`recipients[${String(k)}]`, `Recipient ${String(k + 1)} needs a name of at most 120 characters, a kind, and a two-letter country code such as IN.`);
      return;
    }
    recipients.push({ name: rn, role: r.role, country });
  });

  if (f.crossBorder === "") add("crossBorder", "Say whether data is sent to another country.");
  let transferCountries: string[] = [];
  if (f.crossBorder === "yes") {
    transferCountries = countryCodes(f.transferCountries);
    if (transferCountries.length === 0) add("transferCountries", "Countries data is sent to: name at least one, with two-letter codes such as US.");
    else if (transferCountries.some((c) => !COUNTRY.test(c))) add("transferCountries", "Countries data is sent to: use two-letter codes such as US.");
    else if (new Set(transferCountries).size !== transferCountries.length) add("transferCountries", "Countries data is sent to: a country is listed twice.");
  }
  const retention = text(f.retention, "retention", "How long it is kept", 300);
  const measures = MEASURES.filter((m) => f.securityMeasures[m]);
  const other = f.otherMeasures.trim();
  if (other.length > 300) add("otherMeasures", "Other ways it is protected: use at most 300 characters.");
  if (measures.length === 0 && other === "") add("securityMeasures", "Choose at least one way the data is protected, or describe it under other ways.");
  const storage = text(f.storage, "storage", "Where it is kept", 200);
  const owner = text(f.owner, "owner", "Who is responsible", 120);

  if (problems.length > start || f.legalBasis === "" || f.source === "" || f.involvesChildren === "" || f.crossBorder === "") return undefined;
  return {
    name, description, purposes, legalBasis: f.legalBasis, principals, personalData, involvesChildren: f.involvesChildren === "yes", source: f.source, recipients,
    crossBorder: f.crossBorder === "yes", transferCountries, retention, securityMeasures: measures, ...(other === "" ? {} : { otherMeasures: other }), storage, owner,
  };
}

/** Turns the form into the record the server stores, or says every gap at once. Nothing is sent until it is all right. */
export function buildRopaDocument(form: RopaForm, now: Date): Built<RopaDocument> {
  const problems: Problem[] = [];
  const add = (field: string, message: string) => problems.push({ field, message });
  const o = form.organisation;
  const name = checkedText(o.name, "organisation.name", "Name of the organisation", 200, add);
  const address = checkedText(o.address, "organisation.address", "Address", 500, add);
  const contactName = checkedText(o.contactName, "organisation.contactName", "Contact person", 120, add);
  const email = checkedText(o.contactEmail, "organisation.contactEmail", "Contact email", 254, add);
  if (email !== "" && email.length <= 254 && !EMAIL.test(email)) add("organisation.contactEmail", "Contact email: this is not an email address.");
  let website: string | undefined;
  if (o.website.trim() !== "") {
    website = o.website.trim();
    let url: URL | undefined;
    try {
      url = new URL(website);
    } catch {
      url = undefined;
    }
    if (website.length > 300) add("organisation.website", "Website: use at most 300 characters.");
    else if (url === undefined || url.protocol !== "https:" || url.username !== "" || url.password !== "") add("organisation.website", "Website: use an https address without a user name or password, or leave it empty.");
  }
  const sector = checkedText(o.sector, "organisation.sector", "Line of business", 120, add);
  if (o.significantDataFiduciary === "") add("organisation.significantDataFiduciary", "Say whether the organisation is a significant data fiduciary, or that you are not sure.");

  const today = localDay(now);
  const last = form.lastReviewedOn.trim();
  if (last === "") add("review.lastReviewedOn", "Date of the last review: fill this in.");
  else if (!isRealDay(last)) add("review.lastReviewedOn", "Date of the last review: this is not a real date.");
  else if (last > today) add("review.lastReviewedOn", "Date of the last review: this is in the future.");
  const next = form.nextReviewDue.trim();
  if (next !== "") {
    if (!isRealDay(next)) add("review.nextReviewDue", "Next review due: this is not a real date.");
    else if (isRealDay(last) && next < last) add("review.nextReviewDue", "Next review due: this is before the last review.");
  }

  const activities: RopaActivity[] = [];
  if (form.activities.length < 1 || form.activities.length > MAX_ACTIVITIES) add("activities", `List 1 to ${String(MAX_ACTIVITIES)} processing activities.`);
  const built = form.activities.map((a, i) => buildActivity(a, i, problems));
  const names = form.activities.map((a) => a.name.trim().toLowerCase());
  names.forEach((n, i) => {
    if (n !== "" && names.indexOf(n) !== i) add(`activities[${String(i)}].name`, `Activity ${String(i + 1)} (${form.activities[i]?.name.trim() ?? ""}): another activity has the same name.`);
  });
  for (const a of built) if (a !== undefined) activities.push(a);
  const notes = form.notes.trim();
  if (notes.length > 2000) add("notes", "Notes: use at most 2000 characters.");

  if (problems.length > 0) return { ok: false, problems };
  const doc: RopaDocument = {
    schema: "saral.ropa/1",
    organisation: { name, address, contactName, contactEmail: email, ...(website === undefined ? {} : { website }), sector, significantDataFiduciary: o.significantDataFiduciary as RopaYesNoUnsure },
    review: { lastReviewedOn: last, ...(next === "" ? {} : { nextReviewDue: next }) },
    activities, ...(notes === "" ? {} : { notes }),
  };
  if (utf8Length(JSON.stringify(doc)) > MAX_BYTES) {
    return { ok: false, problems: [{ field: "document", message: "The record is larger than 90 KiB: shorten the longest answers or remove an activity." }] };
  }
  return { ok: true, request: doc };
}

/** Which step of the form a problem is about: 1 is the organisation and its review, 2 is the activities and everything else. */
export const problemStep = (field: string): 1 | 2 => (field.startsWith("organisation") || field.startsWith("review") ? 1 : 2);

const LABELS: Record<string, string> = {
  "organisation.name": "Name of the organisation", "organisation.address": "Address", "organisation.contactName": "Contact person", "organisation.contactEmail": "Contact email",
  "organisation.website": "Website", "organisation.sector": "Line of business", "organisation.significantDataFiduciary": "Significant data fiduciary",
  "review.lastReviewedOn": "Date of the last review", "review.nextReviewDue": "Next review due", activities: "Activities", notes: "Notes", note: "Note",
  name: "Name of the activity", description: "What the organisation does", purposes: "Why it is done", legalBasis: "Reason it is allowed", principals: "Whose data it is",
  personalData: "What data is kept", involvesChildren: "Children's data", source: "Where the data comes from", recipients: "Recipients", crossBorder: "Data sent to another country",
  transferCountries: "Countries data is sent to", retention: "How long it is kept", securityMeasures: "How it is protected", otherMeasures: "Other ways it is protected",
  storage: "Where it is kept", owner: "Who is responsible",
};

/** The words for what the server refused. The form checks the same rules first, so this is for a rule that has changed or a race. */
export function problemsFromRopaError(e: unknown): string[] {
  if (!(e instanceof ApiError)) return ["Something went wrong. Try again."];
  const body = (e.body ?? {}) as { error?: unknown; field?: unknown; message?: unknown; latest?: unknown };
  if (e.status === 409 && body.error === "unchanged") return ["Nothing has changed since the last saved version, so nothing was saved."];
  if (e.status === 409 && body.error === "stale") {
    const which = typeof body.latest === "number" ? `Version ${String(body.latest)}` : "Another version";
    return [`${which} was saved by someone else after you started. Close this form, read ${typeof body.latest === "number" ? "that version" : "the newest version"}, and make your changes again.`];
  }
  if (e.status === 409 && body.error === "version_limit") return ["200 versions have been saved, which is the most that can be kept, so no more can be saved."];
  if (typeof body.field === "string" && typeof body.message === "string") {
    const field = body.field;
    if (field === "document") return [`The record ${body.message}.`];
    const path = field.startsWith("document.") ? field.slice("document.".length) : field;
    const activity = /^activities\[(\d+)\]\.(.+)$/.exec(path);
    if (activity !== null) {
      const key = (activity[2] as string).replace(/\[\d+\].*$/, "");
      return [`Activity ${String(Number(activity[1]) + 1)}: ${(LABELS[key] ?? key).replace(/^./, (c) => c.toLowerCase())} ${body.message}.`];
    }
    return [`${LABELS[path] ?? path} ${body.message}.`];
  }
  return [e.message];
}

export type ReviewTone = "overdue" | "soon" | "ok";

/** How long until the next review, in words. An overdue one is said to be overdue and by how many days. */
export function reviewLine(review: RopaDocument["review"], now: Date): { text: string; tone: ReviewTone } {
  if (review.nextReviewDue === undefined) return { text: "No date is set for the next review.", tone: "ok" };
  const days = Math.round((Date.parse(`${review.nextReviewDue}T00:00:00Z`) - Date.parse(`${localDay(now)}T00:00:00Z`)) / DAY_MS);
  const plural = (n: number) => `${String(n)} ${n === 1 ? "day" : "days"}`;
  const date = dayLabel(review.nextReviewDue);
  if (days < 0) return { text: `Next review was due ${date}: overdue by ${plural(-days)}.`, tone: "overdue" };
  if (days === 0) return { text: `Next review is due today (${date}).`, tone: "soon" };
  return { text: `Next review due ${date} (in ${plural(days)}).`, tone: days <= 3 ? "soon" : "ok" };
}

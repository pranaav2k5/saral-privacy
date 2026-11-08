import { ApiError, type Breach, type BreachNature, type BreachPatch, type BreachRequest, type BreachState } from "./api";
import { when } from "./format";

const NATURES: readonly BreachNature[] = ["confidentiality", "integrity", "availability"];
const SKEW_MS = 5 * 60_000;
const TEN_YEARS_MS = 10 * 366 * 86_400_000;
const MAX_PEOPLE = 1_000_000_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;

export interface BreachForm {
  title: string;
  description: string;
  /** What a datetime-local box holds: the reader's own local time, as `YYYY-MM-DDTHH:mm`. */
  discoveredAt: string;
  occurredAt: string;
  nature: Record<BreachNature, boolean>;
  /** One kind of personal data on each line. */
  dataCategories: string;
  approx: string;
  consequences: string;
  measures: string;
}

export interface Problem {
  field: string;
  message: string;
}

export const emptyBreachForm = (): BreachForm => ({
  title: "", description: "", discoveredAt: "", occurredAt: "", nature: { confidentiality: false, integrity: false, availability: false },
  dataCategories: "", approx: "", consequences: "", measures: "",
});

const pad = (n: number): string => String(n).padStart(2, "0");
/** An instant as a datetime-local box wants it: the reader's local time to the minute. */
const toLocalBox = (iso: string): string => {
  const d = new Date(iso);
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function formFromBreach(b: Breach): BreachForm {
  return {
    title: b.title, description: b.description, discoveredAt: toLocalBox(b.discoveredAt), occurredAt: b.occurredAt === null ? "" : toLocalBox(b.occurredAt),
    nature: { confidentiality: b.nature.includes("confidentiality"), integrity: b.nature.includes("integrity"), availability: b.nature.includes("availability") },
    dataCategories: b.dataCategories.join("\n"), approx: b.approxPrincipalsAffected === null ? "" : String(b.approxPrincipalsAffected),
    consequences: b.likelyConsequences, measures: b.measuresTaken,
  };
}

/** A time the person typed, checked: a real time, not in the future, not more than ten years ago. Returns the instant or the words to say. */
function when_(value: string, now: Date): { ok: true; at: Date } | { ok: false; message: string } {
  const at = new Date(value);
  if (value.trim() === "" || Number.isNaN(at.getTime())) return { ok: false, message: "That is not a date and time." };
  if (at.getTime() > now.getTime() + SKEW_MS) return { ok: false, message: "That is in the future." };
  if (at.getTime() < now.getTime() - TEN_YEARS_MS) return { ok: false, message: "That is more than ten years ago." };
  return { ok: true, at };
}

const wholeNumber = (v: string): number | null => (/^[0-9]{1,10}$/.test(v) && Number(v) <= MAX_PEOPLE ? Number(v) : null);

export type Built<T> = { ok: true; request: T } | { ok: false; problems: Problem[] };

/** Turns the form into the API's request, or says every gap at once. Nothing is sent until it is all right. */
export function buildBreachRequest(form: BreachForm, now: Date): Built<BreachRequest> {
  const problems: Problem[] = [];
  const add = (field: string, message: string) => problems.push({ field, message });
  const title = form.title.trim();
  if (title === "") add("title", "Give the incident a short title.");
  else if (title.length > 120) add("title", "Use a title of at most 120 characters.");
  const description = form.description.trim();
  if (description === "") add("description", "Say what happened.");
  else if (description.length > 4000) add("description", "Use at most 4000 characters to say what happened.");

  let discovered: Date | undefined;
  if (form.discoveredAt.trim() === "") add("discoveredAt", "Say when the organisation found out.");
  else {
    const d = when_(form.discoveredAt, now);
    if (d.ok) discovered = d.at;
    else add("discoveredAt", d.message);
  }
  let occurred: Date | undefined;
  if (form.occurredAt.trim() !== "") {
    const o = when_(form.occurredAt, now);
    if (!o.ok) add("occurredAt", o.message);
    else if (discovered !== undefined && o.at.getTime() > discovered.getTime()) add("occurredAt", "That is after the time it was found.");
    else occurred = o.at;
  }

  const nature = NATURES.filter((n) => form.nature[n]);
  if (nature.length === 0) add("nature", "Choose at least one way the data was affected.");

  const categories = form.dataCategories.split("\n").map((x) => x.trim()).filter((x) => x !== "");
  if (categories.length === 0) add("dataCategories", "List at least one kind of personal data, one on each line.");
  else if (categories.length > 20) add("dataCategories", "List at most 20 kinds.");
  else if (categories.some((c) => c.length > 100)) add("dataCategories", "Keep each kind to at most 100 characters.");
  else if (new Set(categories.map((c) => c.toLowerCase())).size !== categories.length) add("dataCategories", "A kind is listed twice.");

  let approx: number | undefined;
  if (form.approx.trim() !== "") {
    const n = wholeNumber(form.approx.trim());
    if (n === null) add("approx", "Use a whole number, or leave it empty if it is not known.");
    else approx = n;
  }
  const consequences = form.consequences.trim();
  if (consequences === "") add("likelyConsequences", "Say what could happen to the people affected.");
  else if (consequences.length > 2000) add("likelyConsequences", "Use at most 2000 characters.");
  const measures = form.measures.trim();
  if (measures === "") add("measuresTaken", "Say what has been done about it.");
  else if (measures.length > 2000) add("measuresTaken", "Use at most 2000 characters.");

  if (problems.length > 0 || discovered === undefined) return { ok: false, problems };
  return {
    ok: true,
    request: {
      title, description, discoveredAt: discovered.toISOString(), ...(occurred === undefined ? {} : { occurredAt: occurred.toISOString() }), nature, dataCategories: categories,
      ...(approx === undefined ? {} : { approxPrincipalsAffected: approx }), likelyConsequences: consequences, measuresTaken: measures,
    },
  };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Only what the person changed. A time is unchanged if the box still shows what it showed for the incident, whatever seconds it had. */
export function buildBreachPatch(form: BreachForm, original: Breach, now: Date): { ok: true; patch: BreachPatch } | { ok: false; problems: Problem[] } {
  const built = buildBreachRequest(form, now);
  if (!built.ok) return built;
  const r = built.request;
  const before = formFromBreach(original);
  const patch: BreachPatch = {};
  if (r.title !== original.title) patch.title = r.title;
  if (r.description !== original.description) patch.description = r.description;
  if (form.discoveredAt !== before.discoveredAt) patch.discoveredAt = r.discoveredAt;
  if (form.occurredAt !== before.occurredAt) patch.occurredAt = r.occurredAt ?? null;
  if (!sameList(r.nature, original.nature)) patch.nature = r.nature;
  if (!sameList(r.dataCategories, original.dataCategories)) patch.dataCategories = r.dataCategories;
  if ((r.approxPrincipalsAffected ?? null) !== original.approxPrincipalsAffected) patch.approxPrincipalsAffected = r.approxPrincipalsAffected ?? null;
  if (r.likelyConsequences !== original.likelyConsequences) patch.likelyConsequences = r.likelyConsequences;
  if (r.measuresTaken !== original.measuresTaken) patch.measuresTaken = r.measuresTaken;
  return { ok: true, patch };
}

export function buildBoardNotified(form: { notifiedAt: string; reference: string }, discoveredAt: string, now: Date): Built<{ notifiedAt: string; reference: string }> {
  const problems: Problem[] = [];
  let at: Date | undefined;
  if (form.notifiedAt.trim() === "") problems.push({ field: "notifiedAt", message: "Say when you told the Board." });
  else {
    const t = when_(form.notifiedAt, now);
    if (!t.ok) problems.push({ field: "notifiedAt", message: t.message });
    else if (t.at.getTime() < new Date(discoveredAt).getTime()) problems.push({ field: "notifiedAt", message: "That is before the breach was found." });
    else at = t.at;
  }
  const reference = form.reference.trim();
  if (reference === "") problems.push({ field: "reference", message: "Enter the reference the Board gave." });
  else if (reference.length > 200) problems.push({ field: "reference", message: "Use at most 200 characters." });
  if (problems.length > 0 || at === undefined) return { ok: false, problems };
  return { ok: true, request: { notifiedAt: at.toISOString(), reference } };
}

export function buildPrincipals(form: { how: string; count: string }): Built<{ how: string; count: number }> {
  const problems: Problem[] = [];
  const how = form.how.trim();
  if (how === "") problems.push({ field: "how", message: "Say how the people were told." });
  else if (how.length > 1000) problems.push({ field: "how", message: "Use at most 1000 characters." });
  let count: number | undefined;
  if (form.count.trim() === "") problems.push({ field: "count", message: "Say how many people were told (0 if nobody was affected)." });
  else {
    const n = wholeNumber(form.count.trim());
    if (n === null) problems.push({ field: "count", message: "Use a whole number." });
    else count = n;
  }
  if (problems.length > 0 || count === undefined) return { ok: false, problems };
  return { ok: true, request: { how, count } };
}

export function stateWords(s: BreachState): string {
  return { reported: "Reported, waiting for sign-off", signed_off: "Signed off", board_notified: "Board told", closed: "Closed" }[s];
}

const plural = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? "" : "s"}`;
export type BoardTone = "ok" | "soon" | "overdue" | "done";

/** What to say about the Board's deadline: how long is left or how late it is, or when it was told and whether that was late. */
export function boardLine(b: Breach, now: Date = new Date()): { text: string; tone: BoardTone } {
  if (b.boardNotifiedAt !== null) {
    const late = b.boardNotifiedLate === true;
    return { text: `Board told ${when(b.boardNotifiedAt)}${late ? ", after the deadline" : ""}`, tone: late ? "overdue" : "done" };
  }
  const diff = Date.parse(b.boardDeadline) - now.getTime();
  if (diff < 0) {
    const late = -diff;
    return { text: `Board not told: ${late >= DAY ? plural(Math.floor(late / DAY), "day") : plural(Math.max(1, Math.floor(late / HOUR)), "hour")} late`, tone: "overdue" };
  }
  if (diff >= DAY) return { text: `Board to be told in ${plural(Math.floor(diff / DAY), "day")}`, tone: "ok" };
  return { text: diff < HOUR ? "Board to be told in under an hour" : `Board to be told in ${plural(Math.floor(diff / HOUR), "hour")}`, tone: "soon" };
}

const LABELS: Record<string, string> = {
  title: "Title", description: "What happened", discoveredAt: "When it was found", occurredAt: "When it happened", nature: "How the data was affected",
  dataCategories: "Kinds of personal data", approxPrincipalsAffected: "Number of people", likelyConsequences: "What could happen to people", measuresTaken: "What has been done",
  notifiedAt: "When the Board was told", reference: "Reference", how: "How the people were told", count: "Number of people told", note: "Closing note",
};

/** What to tell the person when the server turned something down, in its words with the field named. */
export function problemsFromBreachError(e: unknown): string[] {
  if (!(e instanceof ApiError)) return ["Something went wrong. Try again."];
  const body = (e.body ?? {}) as { field?: unknown; message?: unknown };
  if (typeof body.field === "string" && typeof body.message === "string") return [`${LABELS[body.field] ?? body.field}: ${body.message}.`];
  return [e.message];
}

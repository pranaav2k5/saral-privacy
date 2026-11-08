import { ApiError, type Breach } from "./api";
import { boardLine, buildBoardNotified, buildBreachPatch, buildBreachRequest, buildPrincipals, emptyBreachForm, formFromBreach, problemsFromBreachError, stateWords, type BreachForm } from "./breach-form";

const NOW = new Date("2026-11-06T12:00:00Z");
const local = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getFullYear())}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const filled = (over: Partial<BreachForm> = {}): BreachForm => ({
  ...emptyBreachForm(),
  title: "  Laptop lost ",
  description: "A laptop with a customer list was lost.",
  discoveredAt: local("2026-11-06T09:00:00Z"),
  occurredAt: local("2026-11-05T20:00:00Z"),
  nature: { confidentiality: true, integrity: false, availability: true },
  dataCategories: "phone numbers\n Names \n\n",
  approx: " 120 ",
  consequences: "Calls from strangers.",
  measures: "The laptop was wiped.",
  ...over,
});
const breach = (over: Partial<Breach> = {}): Breach => ({
  id: "b1", state: "reported", title: "Laptop lost", description: "A laptop was lost.", discoveredAt: "2026-11-06T09:00:00.000Z", occurredAt: null, nature: ["confidentiality"],
  dataCategories: ["phone numbers"], approxPrincipalsAffected: null, likelyConsequences: "Calls.", measuresTaken: "Wiped.", reportedAt: "2026-11-06T09:30:00.000Z", reportedBy: "staff:x",
  boardDeadline: "2026-11-09T09:00:00.000Z", boardOverdue: false, boardNotifiedLate: null, signedOffAt: null, signedOffBy: null, boardNotifiedAt: null, boardReference: null,
  principalsNotifiedAt: null, principalsHow: null, principalsCount: null, closedAt: null, closingNote: null, ...over,
});

describe("buildBreachRequest", () => {
  test("turns the form into the request: text trimmed, times as UTC, nature in the API's order, lists split, the number as a number", () => {
    const r = buildBreachRequest(filled(), NOW);
    expect(r).toEqual({
      ok: true,
      request: {
        title: "Laptop lost", description: "A laptop with a customer list was lost.", discoveredAt: new Date(filled().discoveredAt).toISOString(),
        occurredAt: new Date(filled().occurredAt).toISOString(), nature: ["confidentiality", "availability"], dataCategories: ["phone numbers", "Names"],
        approxPrincipalsAffected: 120, likelyConsequences: "Calls from strangers.", measuresTaken: "The laptop was wiped.",
      },
    });
  });

  test("leaves out the time it happened and the number when they are blank", () => {
    const r = buildBreachRequest(filled({ occurredAt: "", approx: "  " }), NOW);
    expect(r.ok && "occurredAt" in r.request).toBe(false);
    expect(r.ok && "approxPrincipalsAffected" in r.request).toBe(false);
  });

  test("reports every gap at once, each named in words, before anything is sent", () => {
    const r = buildBreachRequest(emptyBreachForm(), NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.map((p) => p.field)).toEqual(["title", "description", "discoveredAt", "nature", "dataCategories", "likelyConsequences", "measuresTaken"]);
    expect(r.problems.map((p) => p.message)).toEqual([
      "Give the incident a short title.", "Say what happened.", "Say when the organisation found out.", "Choose at least one way the data was affected.",
      "List at least one kind of personal data, one on each line.", "Say what could happen to the people affected.", "Say what has been done about it.",
    ]);
  });

  test.each([
    ["a title over 120 characters", { title: "x".repeat(121) }, "title"],
    ["a description over 4000 characters", { description: "x".repeat(4001) }, "description"],
    ["a discovery time that is not a time", { discoveredAt: "not a time" }, "discoveredAt"],
    ["a discovery in the future", { discoveredAt: local("2026-11-07T12:00:00Z") }, "discoveredAt"],
    ["an occurrence after the discovery", { occurredAt: local("2026-11-06T10:00:00Z") }, "occurredAt"],
    ["more than 20 kinds of data", { dataCategories: Array.from({ length: 21 }, (_, i) => `k${String(i)}`).join("\n") }, "dataCategories"],
    ["a kind of data given twice", { dataCategories: "Names\nnames" }, "dataCategories"],
    ["a kind of data over 100 characters", { dataCategories: "x".repeat(101) }, "dataCategories"],
    ["a number of people that is not a whole number", { approx: "1.5" }, "approx"],
    ["a negative number of people", { approx: "-1" }, "approx"],
    ["a number of people that is text", { approx: "many" }, "approx"],
    ["consequences over 2000 characters", { consequences: "x".repeat(2001) }, "likelyConsequences"],
    ["measures over 2000 characters", { measures: "x".repeat(2001) }, "measuresTaken"],
  ])("refuses %s, naming the field", (_n, over, field) => {
    const r = buildBreachRequest(filled(over as Partial<BreachForm>), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.map((p) => p.field)).toContain(field);
  });
});

describe("buildBreachPatch", () => {
  test("sends only what was changed, and nothing at all when nothing was", () => {
    const original = breach({ title: "Laptop lost", description: "A laptop was lost.", discoveredAt: "2026-11-06T09:00:00.000Z", dataCategories: ["phone numbers"], likelyConsequences: "Calls.", measuresTaken: "Wiped." });
    const same = formFromBreach(original);
    expect(buildBreachPatch(same, original, NOW)).toEqual({ ok: true, patch: {} });
    const changed = buildBreachPatch({ ...same, description: " A different account. ", approx: "40" }, original, NOW);
    expect(changed).toEqual({ ok: true, patch: { description: "A different account.", approxPrincipalsAffected: 40 } });
  });

  test("clears the time it happened or the number with null when the box is emptied", () => {
    const original = breach({ occurredAt: "2026-11-05T20:00:00.000Z", approxPrincipalsAffected: 10 });
    const r = buildBreachPatch({ ...formFromBreach(original), occurredAt: "", approx: "" }, original, NOW);
    expect(r).toEqual({ ok: true, patch: { occurredAt: null, approxPrincipalsAffected: null } });
  });

  test("checks what it changes the same way as a new report", () => {
    const original = breach();
    const r = buildBreachPatch({ ...formFromBreach(original), title: "" }, original, NOW);
    expect(r.ok).toBe(false);
  });
});

describe("formFromBreach", () => {
  test("fills the form from an incident, times in the reader's local time and lists one to a line", () => {
    const f = formFromBreach(breach({ occurredAt: "2026-11-05T20:00:00.000Z", approxPrincipalsAffected: 7, nature: ["integrity", "availability"], dataCategories: ["a", "b"] }));
    expect(f.discoveredAt).toBe(local("2026-11-06T09:00:00.000Z"));
    expect(f.occurredAt).toBe(local("2026-11-05T20:00:00.000Z"));
    expect(f.nature).toEqual({ confidentiality: false, integrity: true, availability: true });
    expect(f.dataCategories).toBe("a\nb");
    expect(f.approx).toBe("7");
  });
});

describe("the steps after sign-off", () => {
  test("the time the Board was told is turned into UTC, needs a reference, and cannot be before the breach was found or in the future", () => {
    const found = "2026-11-06T09:00:00.000Z";
    expect(buildBoardNotified({ notifiedAt: local("2026-11-06T10:00:00Z"), reference: " DPB-1 " }, found, NOW)).toEqual({ ok: true, request: { notifiedAt: new Date(local("2026-11-06T10:00:00Z")).toISOString(), reference: "DPB-1" } });
    expect(buildBoardNotified({ notifiedAt: "", reference: "x" }, found, NOW)).toMatchObject({ ok: false, problems: [{ field: "notifiedAt" }] });
    expect(buildBoardNotified({ notifiedAt: local("2026-11-06T08:00:00Z"), reference: "x" }, found, NOW)).toMatchObject({ ok: false, problems: [{ field: "notifiedAt", message: "That is before the breach was found." }] });
    expect(buildBoardNotified({ notifiedAt: local("2026-11-07T12:00:00Z"), reference: "x" }, found, NOW)).toMatchObject({ ok: false, problems: [{ field: "notifiedAt" }] });
    expect(buildBoardNotified({ notifiedAt: local("2026-11-06T10:00:00Z"), reference: " " }, found, NOW)).toMatchObject({ ok: false, problems: [{ field: "reference" }] });
    expect(buildBoardNotified({ notifiedAt: local("2026-11-06T10:00:00Z"), reference: "x".repeat(201) }, found, NOW)).toMatchObject({ ok: false });
  });

  test("how the people were told is required, and how many is a whole number that may be zero", () => {
    expect(buildPrincipals({ how: " Email ", count: " 0 " })).toEqual({ ok: true, request: { how: "Email", count: 0 } });
    expect(buildPrincipals({ how: "", count: "5" })).toMatchObject({ ok: false, problems: [{ field: "how" }] });
    expect(buildPrincipals({ how: "Email", count: "" })).toMatchObject({ ok: false, problems: [{ field: "count" }] });
    expect(buildPrincipals({ how: "Email", count: "-1" })).toMatchObject({ ok: false });
    expect(buildPrincipals({ how: "Email", count: "1.5" })).toMatchObject({ ok: false });
    expect(buildPrincipals({ how: "x".repeat(1001), count: "1" })).toMatchObject({ ok: false });
  });
});

describe("words for the state and the Board's deadline", () => {
  test("a state is said in words", () => {
    expect(stateWords("reported")).toBe("Reported, waiting for sign-off");
    expect(stateWords("signed_off")).toBe("Signed off");
    expect(stateWords("board_notified")).toBe("Board told");
    expect(stateWords("closed")).toBe("Closed");
  });

  test("before the Board is told it says when it is due, or how late it is, and after that when it was told and whether that was late", () => {
    const base = breach();
    expect(boardLine(base, new Date("2026-11-07T09:00:00Z"))).toEqual({ text: "Board to be told in 2 days", tone: "ok" });
    expect(boardLine(base, new Date("2026-11-08T21:00:00Z"))).toEqual({ text: "Board to be told in 12 hours", tone: "soon" });
    expect(boardLine({ ...base, boardOverdue: true }, new Date("2026-11-10T11:00:00Z"))).toEqual({ text: "Board not told: 1 day late", tone: "overdue" });
    expect(boardLine({ ...base, boardOverdue: true }, new Date("2026-11-09T12:00:00Z"))).toEqual({ text: "Board not told: 3 hours late", tone: "overdue" });
    const told = breach({ state: "board_notified", boardNotifiedAt: "2026-11-07T10:00:00.000Z", boardNotifiedLate: false });
    expect(boardLine(told, NOW).tone).toBe("done");
    expect(boardLine(told, NOW).text).toMatch(/^Board told /);
    expect(boardLine({ ...told, boardNotifiedLate: true }, NOW)).toMatchObject({ tone: "overdue" });
    expect(boardLine({ ...told, boardNotifiedLate: true }, NOW).text).toMatch(/after the deadline$/);
  });
});

describe("problemsFromBreachError", () => {
  test("shows the server's own words with the field named, or its message, or a plain fallback", () => {
    expect(problemsFromBreachError(new ApiError(400, "m", { field: "dataCategories", message: "a kind is listed twice" }))).toEqual(["Kinds of personal data: a kind is listed twice."]);
    expect(problemsFromBreachError(new ApiError(409, "an incident cannot be changed once it has been signed off", { error: "locked" }))).toEqual(["an incident cannot be changed once it has been signed off"]);
    expect(problemsFromBreachError(new TypeError("x"))).toEqual(["Something went wrong. Try again."]);
    expect(problemsFromBreachError(new ApiError(400, "Check what you entered.", { field: "unknownthing", message: "is odd" }))).toEqual(["unknownthing: is odd."]);
  });
});

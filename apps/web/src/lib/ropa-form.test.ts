import { ApiError, type RopaDocument } from "./api";
import {
  LEGAL_BASIS_WORDS, MEASURE_WORDS, SOURCE_WORDS, buildRopaDocument, emptyActivityForm, emptyRopaForm, formFromRopa, problemStep, problemsFromRopaError, reviewLine,
  type ActivityForm, type RopaForm,
} from "./ropa-form";

/** Local noon on 6 November 2026, so the local day is the 6th wherever the tests run. */
const NOW = new Date(2026, 10, 6, 12, 0, 0);

const activityForm = (over: Partial<ActivityForm> = {}): ActivityForm => ({
  name: "  Payroll  ", description: "Paying staff each month.", purposes: "Pay salaries\n\n  File tax returns  \n", legalBasis: "legitimate_use", principals: "Employees",
  personalData: "Name\nBank account number", involvesChildren: "no", source: "directly_from_person",
  recipients: [{ name: " Acme Bank ", role: "processor", country: " in " }, { name: "", role: "", country: "" }],
  crossBorder: "yes", transferCountries: "us, sg\nIN", retention: "Seven years after the person leaves.",
  securityMeasures: { encryption_at_rest: false, encryption_in_transit: true, access_control: true, multi_factor: false, logging: false, backups: true, pseudonymisation: false, physical_security: false },
  otherMeasures: "", storage: "Cloud accounting software", owner: "Finance manager", ...over,
});
const form = (over: Partial<RopaForm> = {}): RopaForm => ({
  organisation: { name: " Example Traders ", address: "1 Market Road, Pune", contactName: "A. Rao", contactEmail: "dpo@example.org", website: "", sector: "Retail", significantDataFiduciary: "no" },
  lastReviewedOn: "2026-10-01", nextReviewDue: "", activities: [activityForm()], notes: "", ...over,
});
const DOC: RopaDocument = {
  schema: "saral.ropa/1",
  organisation: { name: "Example Traders", address: "1 Market Road, Pune", contactName: "A. Rao", contactEmail: "dpo@example.org", sector: "Retail", significantDataFiduciary: "no" },
  review: { lastReviewedOn: "2026-10-01" },
  activities: [{
    name: "Payroll", description: "Paying staff each month.", purposes: ["Pay salaries", "File tax returns"], legalBasis: "legitimate_use", principals: ["Employees"],
    personalData: ["Name", "Bank account number"], involvesChildren: false, source: "directly_from_person", recipients: [{ name: "Acme Bank", role: "processor", country: "IN" }],
    crossBorder: true, transferCountries: ["US", "SG", "IN"], retention: "Seven years after the person leaves.", securityMeasures: ["encryption_in_transit", "access_control", "backups"],
    storage: "Cloud accounting software", owner: "Finance manager",
  }],
};
const problemsOf = (f: RopaForm, now = NOW) => {
  const r = buildRopaDocument(f, now);
  if (r.ok) throw new Error("expected problems");
  return r.problems;
};
const withActivity = (over: Partial<ActivityForm>) => form({ activities: [activityForm(over)] });
const withOrg = (over: Partial<RopaForm["organisation"]>) => form({ organisation: { ...form().organisation, ...over } });
const fields = (f: RopaForm) => problemsOf(f).map((p) => p.field);

describe("an empty form", () => {
  test("has one empty activity and no answer chosen for any yes or no question, so nothing is answered for the person", () => {
    const f = emptyRopaForm();
    expect(f.activities).toHaveLength(1);
    expect(f.activities[0]).toEqual(emptyActivityForm());
    const a = emptyActivityForm();
    expect([a.legalBasis, a.involvesChildren, a.source, a.crossBorder]).toEqual(["", "", "", ""]);
    expect(f.organisation.significantDataFiduciary).toBe("");
    expect(Object.values(a.securityMeasures).every((v) => !v)).toBe(true);
  });

  test("is not a record: every gap is named at once, not one at a time", () => {
    const names = fields(emptyRopaForm());
    for (const f of [
      "organisation.name", "organisation.address", "organisation.contactName", "organisation.contactEmail", "organisation.sector", "organisation.significantDataFiduciary", "review.lastReviewedOn",
      "activities[0].name", "activities[0].description", "activities[0].purposes", "activities[0].legalBasis", "activities[0].principals", "activities[0].personalData",
      "activities[0].involvesChildren", "activities[0].source", "activities[0].crossBorder", "activities[0].retention", "activities[0].securityMeasures", "activities[0].storage", "activities[0].owner",
    ]) expect(names).toContain(f);
  });
});

describe("a complete form", () => {
  test("becomes the record: text trimmed, lists split by line with blanks dropped, countries in capitals, measures in the fixed order, and parts left empty left out", () => {
    const r = buildRopaDocument(form(), NOW);
    expect(r).toEqual({ ok: true, request: DOC });
    expect(Object.keys((r as { request: RopaDocument }).request)).toEqual(["schema", "organisation", "review", "activities"]);
  });

  test("keeps the optional parts when they are given", () => {
    const r = buildRopaDocument(
      form({ organisation: { ...form().organisation, website: " https://example.org/ " }, nextReviewDue: "2027-10-01", notes: " Reviewed with the board. ", activities: [activityForm({ otherMeasures: " Locked cabinet " })] }),
      NOW,
    );
    if (!r.ok) throw new Error(JSON.stringify(r.problems));
    expect(r.request.organisation.website).toBe("https://example.org/");
    expect(r.request.review).toEqual({ lastReviewedOn: "2026-10-01", nextReviewDue: "2027-10-01" });
    expect(r.request.notes).toBe("Reviewed with the board.");
    expect(r.request.activities[0]?.otherMeasures).toBe("Locked cabinet");
  });

  test("a form made from a record builds that record again, with and without the optional parts", () => {
    const full: RopaDocument = {
      ...DOC, organisation: { ...DOC.organisation, website: "https://example.org/" }, review: { lastReviewedOn: "2026-10-01", nextReviewDue: "2027-10-01" }, notes: "Reviewed.",
      activities: [{ ...(DOC.activities[0] as RopaDocument["activities"][number]), otherMeasures: "Locked cabinet", crossBorder: false, transferCountries: [], recipients: [] }],
    };
    for (const doc of [DOC, full]) expect(buildRopaDocument(formFromRopa(doc), NOW)).toEqual({ ok: true, request: doc });
  });

  test("a blank recipient row is ignored, but a half-filled one is a problem naming which row", () => {
    expect(buildRopaDocument(withActivity({ recipients: [{ name: "", role: "", country: "" }] }), NOW).ok).toBe(true);
    const half = problemsOf(withActivity({ recipients: [{ name: "Acme", role: "", country: "IN" }, { name: "", role: "processor", country: "IN" }, { name: "Beta", role: "third_party", country: "" }] }));
    expect(half.map((p) => p.field)).toEqual(["activities[0].recipients[0]", "activities[0].recipients[1]", "activities[0].recipients[2]"]);
    expect(half[0]?.message).toContain("Recipient 1");
  });

  test("when no data goes abroad, a country left in the hidden box is not sent", () => {
    const r = buildRopaDocument(withActivity({ crossBorder: "no", transferCountries: "US" }), NOW);
    if (!r.ok) throw new Error(JSON.stringify(r.problems));
    expect(r.request.activities[0]?.transferCountries).toEqual([]);
  });
});

describe("the organisation", () => {
  test.each([
    ["a name of 201 characters", { name: "x".repeat(201) }, "organisation.name"],
    ["a blank name", { name: "   " }, "organisation.name"],
    ["an address of 501 characters", { address: "x".repeat(501) }, "organisation.address"],
    ["a contact name of 121 characters", { contactName: "x".repeat(121) }, "organisation.contactName"],
    ["a sector of 121 characters", { sector: "x".repeat(121) }, "organisation.sector"],
    ["an email with no @", { contactEmail: "dpo.example.org" }, "organisation.contactEmail"],
    ["an email with a space", { contactEmail: "d po@example.org" }, "organisation.contactEmail"],
    ["an email of 255 characters", { contactEmail: `${"x".repeat(243)}@example.org` }, "organisation.contactEmail"],
    ["a website that is plain http", { website: "http://example.org" }, "organisation.website"],
    ["a website that is not an address", { website: "example.org" }, "organisation.website"],
    ["a website with a password in it", { website: "https://user:pw@example.org/" }, "organisation.website"],
    ["a website with a user name in it", { website: "https://user@example.org/" }, "organisation.website"],
    ["a website of 301 characters", { website: `https://example.org/${"x".repeat(285)}` }, "organisation.website"],
    ["no answer to whether it is a significant data fiduciary", { significantDataFiduciary: "" as never }, "organisation.significantDataFiduciary"],
  ])("refuses %s", (_name, over, field) => {
    expect(fields(withOrg(over))).toEqual([field]);
  });

  test("accepts values at the limits, and 'unsure' as an answer", () => {
    const r = buildRopaDocument(withOrg({ name: "x".repeat(200), address: "x".repeat(500), contactName: "x".repeat(120), sector: "x".repeat(120), contactEmail: `${"x".repeat(242)}@example.org`, significantDataFiduciary: "unsure" }), NOW);
    expect(r.ok).toBe(true);
  });
});

describe("the review dates", () => {
  test.each([
    ["no date", "", "review.lastReviewedOn"],
    ["a date in the wrong form", "6/11/2026", "review.lastReviewedOn"],
    ["a day that does not exist", "2026-02-30", "review.lastReviewedOn"],
    ["a month that does not exist", "2026-13-01", "review.lastReviewedOn"],
    ["tomorrow", "2026-11-07", "review.lastReviewedOn"],
  ])("refuses %s as the last review", (_n, value, field) => {
    expect(fields(form({ lastReviewedOn: value }))).toEqual([field]);
  });

  test("accepts today and a date long ago as the last review", () => {
    expect(buildRopaDocument(form({ lastReviewedOn: "2026-11-06" }), NOW).ok).toBe(true);
    expect(buildRopaDocument(form({ lastReviewedOn: "2019-01-31" }), NOW).ok).toBe(true);
  });

  test("the next review may be the same day as the last or later, never before it, and must be a real date", () => {
    expect(buildRopaDocument(form({ nextReviewDue: "2026-10-01" }), NOW).ok).toBe(true);
    expect(fields(form({ nextReviewDue: "2026-09-30" }))).toEqual(["review.nextReviewDue"]);
    expect(fields(form({ nextReviewDue: "soon" }))).toEqual(["review.nextReviewDue"]);
    expect(fields(form({ nextReviewDue: "2027-02-29" }))).toEqual(["review.nextReviewDue"]);
  });
});

describe("the activities", () => {
  test.each([
    ["a name of 121 characters", { name: "x".repeat(121) }, "activities[0].name"],
    ["a description of 1001 characters", { description: "x".repeat(1001) }, "activities[0].description"],
    ["no purpose", { purposes: " \n \n" }, "activities[0].purposes"],
    ["11 purposes", { purposes: Array.from({ length: 11 }, (_, i) => `p${String(i)}`).join("\n") }, "activities[0].purposes"],
    ["a purpose of 201 characters", { purposes: "x".repeat(201) }, "activities[0].purposes"],
    ["a purpose listed twice, in other letters", { purposes: "Pay staff\npay STAFF" }, "activities[0].purposes"],
    ["no kind of person", { principals: "" }, "activities[0].principals"],
    ["11 kinds of person", { principals: Array.from({ length: 11 }, (_, i) => `p${String(i)}`).join("\n") }, "activities[0].principals"],
    ["a kind of person of 101 characters", { principals: "x".repeat(101) }, "activities[0].principals"],
    ["no personal data", { personalData: "" }, "activities[0].personalData"],
    ["31 kinds of personal data", { personalData: Array.from({ length: 31 }, (_, i) => `d${String(i)}`).join("\n") }, "activities[0].personalData"],
    ["a kind of personal data of 101 characters", { personalData: "x".repeat(101) }, "activities[0].personalData"],
    ["a kind of personal data listed twice", { personalData: "Name\nname" }, "activities[0].personalData"],
    ["no legal basis chosen", { legalBasis: "" as never }, "activities[0].legalBasis"],
    ["no answer about children", { involvesChildren: "" as never }, "activities[0].involvesChildren"],
    ["no source chosen", { source: "" as never }, "activities[0].source"],
    ["no answer about transfers abroad", { crossBorder: "" as never }, "activities[0].crossBorder"],
    ["a transfer abroad with no country", { crossBorder: "yes", transferCountries: "" }, "activities[0].transferCountries"],
    ["a country written with three letters", { transferCountries: "USA" }, "activities[0].transferCountries"],
    ["a country with a digit", { transferCountries: "U5" }, "activities[0].transferCountries"],
    ["the same country twice, in other letters", { transferCountries: "US\nus" }, "activities[0].transferCountries"],
    ["a retention of 301 characters", { retention: "x".repeat(301) }, "activities[0].retention"],
    ["no measure and nothing else said", { securityMeasures: emptyActivityForm().securityMeasures, otherMeasures: "  " }, "activities[0].securityMeasures"],
    ["other measures of 301 characters", { otherMeasures: "x".repeat(301) }, "activities[0].otherMeasures"],
    ["a storage place of 201 characters", { storage: "x".repeat(201) }, "activities[0].storage"],
    ["an owner of 121 characters", { owner: "x".repeat(121) }, "activities[0].owner"],
    ["a recipient name of 121 characters", { recipients: [{ name: "x".repeat(121), role: "processor", country: "IN" }] }, "activities[0].recipients[0]"],
    ["a recipient country of three letters", { recipients: [{ name: "Acme", role: "processor", country: "IND" }] }, "activities[0].recipients[0]"],
  ] as [string, Partial<ActivityForm>, string][])("refuses %s", (_name, over, field) => {
    expect(fields(withActivity(over))).toEqual([field]);
  });

  test("accepts values at the limits", () => {
    const measures = { ...emptyActivityForm().securityMeasures };
    const r = buildRopaDocument(
      withActivity({
        name: "x".repeat(120), description: "x".repeat(1000), purposes: Array.from({ length: 10 }, (_, i) => `${String(i)}${"x".repeat(199)}`).join("\n"),
        principals: Array.from({ length: 10 }, (_, i) => `${String(i)}${"x".repeat(99)}`).join("\n"), personalData: Array.from({ length: 30 }, (_, i) => `${String(i).padStart(2, "0")}${"x".repeat(98)}`).join("\n"),
        retention: "x".repeat(300), storage: "x".repeat(200), owner: "x".repeat(120), securityMeasures: measures, otherMeasures: "x".repeat(300),
        recipients: Array.from({ length: 20 }, (_, i) => ({ name: `r${String(i)}`, role: "third_party" as const, country: "IN" })),
      }),
      NOW,
    );
    expect(r.ok).toBe(true);
  });

  test("21 recipients is too many", () => {
    expect(fields(withActivity({ recipients: Array.from({ length: 21 }, (_, i) => ({ name: `r${String(i)}`, role: "processor" as const, country: "IN" })) }))).toEqual(["activities[0].recipients"]);
  });

  test("security measures alone are enough, other measures alone are enough, and both together are kept", () => {
    const none = emptyActivityForm().securityMeasures;
    const r = buildRopaDocument(withActivity({ securityMeasures: none, otherMeasures: "Locked cabinet" }), NOW);
    if (!r.ok) throw new Error(JSON.stringify(r.problems));
    expect(r.request.activities[0]?.securityMeasures).toEqual([]);
    expect(r.request.activities[0]?.otherMeasures).toBe("Locked cabinet");
  });

  test("a problem in an activity names the activity by number and by name, and an unnamed one by number alone", () => {
    const p = problemsOf(form({ activities: [activityForm(), activityForm({ name: "Newsletter", purposes: "" }), activityForm({ name: "", description: "" })] }));
    expect(p.find((x) => x.field === "activities[1].purposes")?.message).toMatch(/^Activity 2 \(Newsletter\): /);
    expect(p.find((x) => x.field === "activities[2].name")?.message).toMatch(/^Activity 3: /);
  });

  test("two activities with the same name, in other letters, are refused on the second", () => {
    const p = problemsOf(form({ activities: [activityForm(), activityForm({ name: "PAYROLL" })] }));
    expect(p.map((x) => x.field)).toEqual(["activities[1].name"]);
    expect(p[0]?.message).toContain("same name");
  });

  test("none is refused, 30 are accepted, and 31 are refused", () => {
    const many = (n: number) => form({ activities: Array.from({ length: n }, (_, i) => activityForm({ name: `Activity ${String(i)}` })) });
    expect(fields(form({ activities: [] }))).toEqual(["activities"]);
    expect(buildRopaDocument(many(30), NOW).ok).toBe(true);
    expect(fields(many(31))).toEqual(["activities"]);
  });
});

describe("the notes", () => {
  test("may be 2000 characters but not 2001", () => {
    expect(buildRopaDocument(form({ notes: "x".repeat(2000) }), NOW).ok).toBe(true);
    expect(fields(form({ notes: "x".repeat(2001) }))).toEqual(["notes"]);
  });
});

describe("the size of the record", () => {
  const big = (i: number): ActivityForm =>
    activityForm({
      name: `Activity ${String(i)}`, description: "d".repeat(1000), purposes: Array.from({ length: 10 }, (_, k) => `${String(k)}${"p".repeat(199)}`).join("\n"),
      principals: Array.from({ length: 10 }, (_, k) => `${String(k)}${"q".repeat(99)}`).join("\n"), personalData: Array.from({ length: 30 }, (_, k) => `${String(k).padStart(2, "0")}${"r".repeat(98)}`).join("\n"),
      retention: "t".repeat(300), storage: "s".repeat(200), owner: "o".repeat(120),
    });
  const sizeOf = (n: number): number => {
    const r = buildRopaDocument(form({ activities: Array.from({ length: n }, (_, i) => big(i)) }), NOW);
    if (!r.ok) throw new Error(JSON.stringify(r.problems));
    return Buffer.byteLength(JSON.stringify(r.request), "utf8");
  };

  const LIMIT = 90 * 1024;
  const sizeFor = (n: number) => sizeOf(1) + (n - 1) * (sizeOf(2) - sizeOf(1));

  test("a record over 90 KiB is refused with advice, and one just under it is accepted", () => {
    expect(sizeFor(11)).toBeLessThan(LIMIT);
    expect(sizeFor(12)).toBeGreaterThan(LIMIT);
    const over = buildRopaDocument(form({ activities: Array.from({ length: 12 }, (_, i) => big(i)) }), NOW);
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.problems.map((p) => p.field)).toEqual(["document"]);
      expect(over.problems[0]?.message).toContain("90 KiB");
    }
    expect(buildRopaDocument(form({ activities: Array.from({ length: 11 }, (_, i) => big(i)) }), NOW).ok).toBe(true);
  });

  test("the limit is exact: a record of 90 KiB to the byte is accepted and one byte more is refused", () => {
    // Twelve of the large activities, whose descriptions are lengthened a letter at a time to land on the size wanted.
    const sized = (bytes: number) => {
      const base = Buffer.byteLength(JSON.stringify((buildRopaDocument(form({ activities: Array.from({ length: 12 }, (_, i) => ({ ...big(i), description: "d" })) }), NOW) as { request: RopaDocument }).request), "utf8");
      const extra = bytes - base;
      const d = 1 + Math.floor(extra / 12);
      expect(d).toBeLessThanOrEqual(1000);
      const longer = extra % 12;
      return form({ activities: Array.from({ length: 12 }, (_, i) => ({ ...big(i), description: "d".repeat(i < longer ? d + 1 : d) })) });
    };
    const exact = buildRopaDocument(sized(LIMIT), NOW);
    if (!exact.ok) throw new Error(JSON.stringify(exact.problems));
    expect(Buffer.byteLength(JSON.stringify(exact.request), "utf8")).toBe(LIMIT);
    const one = buildRopaDocument(sized(LIMIT + 1), NOW);
    expect(one.ok).toBe(false);
    if (!one.ok) expect(one.problems.map((p) => p.field)).toEqual(["document"]);
  });

  test("the size is counted in bytes: text with 2-byte letters that is short in characters but long in bytes is refused", () => {
    const wide = (i: number): ActivityForm => ({ ...big(i), description: "é".repeat(1000), owner: "é".repeat(120), storage: "é".repeat(200) });
    // The same eleven activities, with 1320 letters each made 2 bytes long: under the limit in characters, over it in bytes.
    expect(sizeFor(11)).toBeLessThan(LIMIT);
    expect(sizeFor(11) + 11 * 1320).toBeGreaterThan(LIMIT);
    const r = buildRopaDocument(form({ activities: Array.from({ length: 11 }, (_, i) => wide(i)) }), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.map((p) => p.field)).toEqual(["document"]);
  });
});

describe("which step a problem belongs to", () => {
  test.each([
    ["organisation.name", 1], ["review.nextReviewDue", 1], ["activities", 2], ["activities[3].owner", 2], ["notes", 2], ["document", 2],
  ])("%s belongs to step %i", (field, step) => {
    expect(problemStep(field)).toBe(step);
  });
});

describe("problems the server reports", () => {
  const bad = (field: string, message: string) => new ApiError(400, "Check what you entered and try again.", { error: "invalid_request", field, message });
  test("name the question in words, and for an activity say which one", () => {
    expect(problemsFromRopaError(bad("document.organisation.contactEmail", "must be an email address"))).toEqual(["Contact email must be an email address."]);
    expect(problemsFromRopaError(bad("document.activities[2].transferCountries", "has a country listed twice"))).toEqual(["Activity 3: countries data is sent to has a country listed twice."]);
    expect(problemsFromRopaError(bad("document.review.nextReviewDue", "cannot be before the last review"))).toEqual(["Next review due cannot be before the last review."]);
    expect(problemsFromRopaError(bad("document", "is larger than 90 KiB: shorten the longest answers or remove an activity"))).toEqual(["The record is larger than 90 KiB: shorten the longest answers or remove an activity."]);
    expect(problemsFromRopaError(bad("note", "must be text of 1 to 500 characters"))).toEqual(["Note must be text of 1 to 500 characters."]);
  });

  test("an unknown field is shown as the server wrote it rather than hidden", () => {
    expect(problemsFromRopaError(bad("document.something.new", "is odd"))).toEqual(["something.new is odd."]);
  });

  test("a save that changes nothing, and a record at its version limit, are said in plain words", () => {
    expect(problemsFromRopaError(new ApiError(409, "That is not possible in the current state.", { error: "unchanged" }))).toEqual(["Nothing has changed since the last saved version, so nothing was saved."]);
    expect(problemsFromRopaError(new ApiError(409, "x", { error: "version_limit" }))).toEqual(["200 versions have been saved, which is the most that can be kept, so no more can be saved."]);
  });

  test("a save started from a version that is no longer the newest says which one is, and what to do", () => {
    const stale = problemsFromRopaError(new ApiError(409, "x", { error: "stale", latest: 5 }));
    expect(stale).toEqual(["Version 5 was saved by someone else after you started. Close this form, read that version, and make your changes again."]);
    expect(problemsFromRopaError(new ApiError(409, "x", { error: "stale" }))).toEqual(["Another version was saved by someone else after you started. Close this form, read the newest version, and make your changes again."]);
  });

  test("any other failure uses the client's words, and a failure that is not from the server is generic", () => {
    expect(problemsFromRopaError(new ApiError(500, "The database is busy."))).toEqual(["The database is busy."]);
    expect(problemsFromRopaError(new TypeError("Failed to fetch"))).toEqual(["Something went wrong. Try again."]);
  });
});

describe("when the next review is due", () => {
  const review = (next?: string) => ({ lastReviewedOn: "2026-01-01", ...(next === undefined ? {} : { nextReviewDue: next }) });
  test("says so when no date is set", () => {
    expect(reviewLine(review(), NOW)).toEqual({ text: "No date is set for the next review.", tone: "ok" });
  });
  test("counts the days to a date ahead, calling the last three days soon", () => {
    expect(reviewLine(review("2026-11-20"), NOW)).toMatchObject({ text: expect.stringContaining("in 14 days"), tone: "ok" });
    expect(reviewLine(review("2026-11-09"), NOW)).toMatchObject({ text: expect.stringContaining("in 3 days"), tone: "soon" });
    expect(reviewLine(review("2026-11-07"), NOW)).toMatchObject({ text: expect.stringContaining("in 1 day)"), tone: "soon" });
  });
  test("says today, and says overdue in words with the number of days, not only by tone", () => {
    expect(reviewLine(review("2026-11-06"), NOW)).toMatchObject({ text: expect.stringContaining("due today"), tone: "soon" });
    expect(reviewLine(review("2026-11-05"), NOW)).toMatchObject({ text: expect.stringContaining("overdue by 1 day"), tone: "overdue" });
    expect(reviewLine(review("2026-10-01"), NOW)).toMatchObject({ text: expect.stringContaining("overdue by 36 days"), tone: "overdue" });
  });
});

describe("the words for the choices", () => {
  test("every choice has words a person can read, with no code names showing", () => {
    for (const words of [...Object.values(LEGAL_BASIS_WORDS), ...Object.values(SOURCE_WORDS), ...Object.values(MEASURE_WORDS)]) {
      expect(words.length).toBeGreaterThan(3);
      expect(words).not.toMatch(/_/);
    }
    expect(Object.keys(MEASURE_WORDS)).toHaveLength(8);
  });
});

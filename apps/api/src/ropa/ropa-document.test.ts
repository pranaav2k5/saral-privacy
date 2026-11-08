import { RopaError, canonicalRopa, parseRopaDocument, SECURITY_MEASURES } from "./ropa-document.js";

const activity = (over: Record<string, unknown> = {}) => ({
  name: "Customer support", description: "We answer questions that customers send us.", purposes: ["Answer customer questions"], legalBasis: "consent",
  principals: ["customers"], personalData: ["name", "email address"], involvesChildren: false, source: "directly_from_person",
  recipients: [{ name: "Helpdesk Cloud Ltd", role: "processor", country: "IN" }], crossBorder: false, transferCountries: [], retention: "12 months after the last message",
  securityMeasures: ["encryption_in_transit", "access_control"], storage: "Helpdesk Cloud, Mumbai region", owner: "Support team", ...over,
});
const doc = (over: Record<string, unknown> = {}) => ({
  schema: "saral.ropa/1",
  organisation: { name: "Example Controller Pvt Ltd", address: "1 Example Road, Bengaluru 560001", contactName: "Grievance Officer", contactEmail: "privacy@example.org", website: "https://example.org", sector: "Software", significantDataFiduciary: "no" },
  review: { lastReviewedOn: "2026-11-01", nextReviewDue: "2027-05-01" },
  activities: [activity()],
  notes: "First version.",
  ...over,
});
const NOW = new Date("2026-11-06T10:00:00Z");
const refused = (raw: unknown, field: string) => {
  try {
    parseRopaDocument(raw, NOW);
  } catch (e) {
    expect(e).toBeInstanceOf(RopaError);
    expect((e as RopaError).field).toBe(field);
    return;
  }
  throw new Error(`accepted, but ${field} should have been refused`);
};

describe("a valid record", () => {
  test("is accepted and returned in its own shape, with text trimmed", () => {
    const parsed = parseRopaDocument(doc({ organisation: { ...doc().organisation, name: "  Example Controller Pvt Ltd  " } }), NOW);
    expect(parsed.organisation.name).toBe("Example Controller Pvt Ltd");
    expect(parsed.activities).toHaveLength(1);
    expect(parsed.activities[0]?.recipients).toEqual([{ name: "Helpdesk Cloud Ltd", role: "processor", country: "IN" }]);
  });

  test("may leave out the optional parts: website, next review, notes, other measures", () => {
    const organisation: Record<string, unknown> = { ...doc().organisation };
    delete organisation.website;
    const raw: Record<string, unknown> = { ...doc(), organisation, review: { lastReviewedOn: "2026-11-01" } };
    delete raw.notes;
    const parsed = parseRopaDocument(raw, NOW);
    expect(parsed.organisation.website).toBeUndefined();
    expect(parsed.review.nextReviewDue).toBeUndefined();
    expect(parsed.notes).toBeUndefined();
  });

  test("with a transfer abroad names the countries, and with none names no country", () => {
    expect(parseRopaDocument(doc({ activities: [activity({ crossBorder: true, transferCountries: ["US", "SG"] })] }), NOW).activities[0]?.transferCountries).toEqual(["US", "SG"]);
  });

  test("may hold up to 30 activities", () => {
    expect(parseRopaDocument(doc({ activities: Array.from({ length: 30 }, (_, i) => activity({ name: `Activity ${String(i)}` })) }), NOW).activities).toHaveLength(30);
  });
});

describe("the canonical text", () => {
  test("is the same whatever order the keys came in, and leaves out what was not given", () => {
    const a = canonicalRopa(parseRopaDocument(doc(), NOW));
    const reordered = { notes: "First version.", activities: [Object.fromEntries(Object.entries(activity()).reverse())], review: { nextReviewDue: "2027-05-01", lastReviewedOn: "2026-11-01" }, organisation: Object.fromEntries(Object.entries(doc().organisation).reverse()), schema: "saral.ropa/1" };
    expect(canonicalRopa(parseRopaDocument(reordered, NOW))).toBe(a);
    const organisation: Record<string, unknown> = { ...doc().organisation };
    delete organisation.website;
    expect(canonicalRopa(parseRopaDocument({ ...doc(), organisation }, NOW))).not.toContain("website");
  });

  test("starts with the schema, is compact JSON, and changes when any answer changes", () => {
    const a = canonicalRopa(parseRopaDocument(doc(), NOW));
    expect(a.startsWith('{"schema":"saral.ropa/1","organisation":')).toBe(true);
    expect(a).not.toContain("\n");
    expect(canonicalRopa(parseRopaDocument(doc({ notes: "Second." }), NOW))).not.toBe(a);
    expect(canonicalRopa(parseRopaDocument(doc({ activities: [activity({ owner: "Someone else" })] }), NOW))).not.toBe(a);
  });

  test("puts the security measures in a fixed order, so the same answers always give the same text", () => {
    const a = canonicalRopa(parseRopaDocument(doc({ activities: [activity({ securityMeasures: ["access_control", "encryption_in_transit"] })] }), NOW));
    const b = canonicalRopa(parseRopaDocument(doc({ activities: [activity({ securityMeasures: ["encryption_in_transit", "access_control"] })] }), NOW));
    expect(a).toBe(b);
    expect(a.indexOf("encryption_in_transit")).toBeLessThan(a.indexOf("access_control"));
  });

  test("round-trips: parsing the canonical text gives the same canonical text", () => {
    const a = canonicalRopa(parseRopaDocument(doc(), NOW));
    expect(canonicalRopa(parseRopaDocument(JSON.parse(a), NOW))).toBe(a);
  });
});

describe("what is refused, naming the field", () => {
  test.each([
    ["not an object", [], "body"],
    ["another schema", doc({ schema: "saral.ropa/2" }), "schema"],
    ["a field that is not part of the record", doc({ extra: 1 }), "extra"],
    ["no organisation", doc({ organisation: undefined }), "organisation"],
    ["an organisation with no name", doc({ organisation: { ...doc().organisation, name: " " } }), "organisation.name"],
    ["an organisation name over 200 characters", doc({ organisation: { ...doc().organisation, name: "x".repeat(201) } }), "organisation.name"],
    ["an organisation with no address", doc({ organisation: { ...doc().organisation, address: "" } }), "organisation.address"],
    ["a contact with no name", doc({ organisation: { ...doc().organisation, contactName: "" } }), "organisation.contactName"],
    ["a contact email that is not an email", doc({ organisation: { ...doc().organisation, contactEmail: "nope" } }), "organisation.contactEmail"],
    ["a website over http", doc({ organisation: { ...doc().organisation, website: "http://example.org" } }), "organisation.website"],
    ["a website with credentials", doc({ organisation: { ...doc().organisation, website: "https://u:p@example.org" } }), "organisation.website"],
    ["no sector", doc({ organisation: { ...doc().organisation, sector: "" } }), "organisation.sector"],
    ["an answer about significant data fiduciaries that is not yes, no or unsure", doc({ organisation: { ...doc().organisation, significantDataFiduciary: "maybe" } }), "organisation.significantDataFiduciary"],
    ["a field in the organisation that is not part of it", doc({ organisation: { ...doc().organisation, ceo: "x" } }), "organisation.ceo"],
    ["no review date", doc({ review: {} }), "review.lastReviewedOn"],
    ["a review date that is not a day", doc({ review: { lastReviewedOn: "2026-13-45" } }), "review.lastReviewedOn"],
    ["a review date in the future", doc({ review: { lastReviewedOn: "2026-12-31" } }), "review.lastReviewedOn"],
    ["a next review before the last", doc({ review: { lastReviewedOn: "2026-11-01", nextReviewDue: "2026-10-01" } }), "review.nextReviewDue"],
    ["notes over 2000 characters", doc({ notes: "x".repeat(2001) }), "notes"],
    ["no activities", doc({ activities: [] }), "activities"],
    ["more than 30 activities", doc({ activities: Array.from({ length: 31 }, () => activity()) }), "activities"],
    ["an activity that is not an object", doc({ activities: ["x"] }), "activities[0]"],
    ["an activity with no name", doc({ activities: [activity({ name: "" })] }), "activities[0].name"],
    ["two activities with the same name", doc({ activities: [activity(), activity({ name: "customer SUPPORT" })] }), "activities[1].name"],
    ["an activity with no description", doc({ activities: [activity({ description: " " })] }), "activities[0].description"],
    ["an activity description over 1000 characters", doc({ activities: [activity({ description: "x".repeat(1001) })] }), "activities[0].description"],
    ["an activity with no purposes", doc({ activities: [activity({ purposes: [] })] }), "activities[0].purposes"],
    ["an activity with a blank purpose", doc({ activities: [activity({ purposes: [" "] })] }), "activities[0].purposes"],
    ["an activity with more than ten purposes", doc({ activities: [activity({ purposes: Array.from({ length: 11 }, (_, i) => `p${String(i)}`) })] }), "activities[0].purposes"],
    ["a legal basis that is not one of the three", doc({ activities: [activity({ legalBasis: "contract" })] }), "activities[0].legalBasis"],
    ["no kinds of people", doc({ activities: [activity({ principals: [] })] }), "activities[0].principals"],
    ["no kinds of personal data", doc({ activities: [activity({ personalData: [] })] }), "activities[0].personalData"],
    ["a kind of personal data given twice", doc({ activities: [activity({ personalData: ["Name", "name"] })] }), "activities[0].personalData"],
    ["more than 30 kinds of personal data", doc({ activities: [activity({ personalData: Array.from({ length: 31 }, (_, i) => `d${String(i)}`) })] }), "activities[0].personalData"],
    ["a children answer that is text", doc({ activities: [activity({ involvesChildren: "no" })] }), "activities[0].involvesChildren"],
    ["a source that is not one of the four", doc({ activities: [activity({ source: "bought" })] }), "activities[0].source"],
    ["a recipient with no name", doc({ activities: [activity({ recipients: [{ name: "", role: "processor", country: "IN" }] })] }), "activities[0].recipients[0].name"],
    ["a recipient that is neither a processor nor a third party", doc({ activities: [activity({ recipients: [{ name: "X", role: "friend", country: "IN" }] })] }), "activities[0].recipients[0].role"],
    ["a recipient country that is not a two-letter code", doc({ activities: [activity({ recipients: [{ name: "X", role: "processor", country: "India" }] })] }), "activities[0].recipients[0].country"],
    ["a recipient country in lower case", doc({ activities: [activity({ recipients: [{ name: "X", role: "processor", country: "in" }] })] }), "activities[0].recipients[0].country"],
    ["more than 20 recipients", doc({ activities: [activity({ recipients: Array.from({ length: 21 }, (_, i) => ({ name: `R${String(i)}`, role: "processor", country: "IN" })) })] }), "activities[0].recipients"],
    ["a transfer abroad with no countries", doc({ activities: [activity({ crossBorder: true, transferCountries: [] })] }), "activities[0].transferCountries"],
    ["countries listed when there is no transfer abroad", doc({ activities: [activity({ crossBorder: false, transferCountries: ["US"] })] }), "activities[0].transferCountries"],
    ["a country given twice", doc({ activities: [activity({ crossBorder: true, transferCountries: ["US", "US"] })] }), "activities[0].transferCountries"],
    ["a country that is not a code", doc({ activities: [activity({ crossBorder: true, transferCountries: ["USA"] })] }), "activities[0].transferCountries"],
    ["a cross-border answer that is text", doc({ activities: [activity({ crossBorder: "yes" })] }), "activities[0].crossBorder"],
    ["no retention", doc({ activities: [activity({ retention: "" })] }), "activities[0].retention"],
    ["retention over 300 characters", doc({ activities: [activity({ retention: "x".repeat(301) })] }), "activities[0].retention"],
    ["no security measures and no other measures", doc({ activities: [activity({ securityMeasures: [] })] }), "activities[0].securityMeasures"],
    ["a security measure that is not on the list", doc({ activities: [activity({ securityMeasures: ["magic"] })] }), "activities[0].securityMeasures"],
    ["a security measure given twice", doc({ activities: [activity({ securityMeasures: ["logging", "logging"] })] }), "activities[0].securityMeasures"],
    ["other measures over 300 characters", doc({ activities: [activity({ otherMeasures: "x".repeat(301) })] }), "activities[0].otherMeasures"],
    ["no place where it is kept", doc({ activities: [activity({ storage: "" })] }), "activities[0].storage"],
    ["no owner", doc({ activities: [activity({ owner: "" })] }), "activities[0].owner"],
    ["a field in an activity that is not part of it", doc({ activities: [activity({ risk: "high" })] }), "activities[0].risk"],
  ])("%s", (_n, raw, field) => refused(raw, field));

  test("a record whose text is more than 90 KiB is refused, and one that is large but under it is accepted", () => {
    // Thirty activities of long answers: about 97 KB in all, which is over the limit, against about 80 KB with two purposes each.
    const big = (purposes: number) =>
      Array.from({ length: 30 }, (_, i) =>
        activity({ name: `A${String(i).padStart(2, "0")}`, description: "d", retention: "r".repeat(300), storage: "s".repeat(200), owner: "o".repeat(120), personalData: Array.from({ length: 20 }, (_, k) => `${"p".repeat(60)}${String(k).padStart(2, "0")}`), purposes: Array.from({ length: purposes }, (_, k) => `${"u".repeat(150)}${String(k)}`) }),
      );
    const bytes = (a: unknown) => Buffer.byteLength(JSON.stringify(doc({ activities: a })), "utf8");
    expect(bytes(big(6))).toBeGreaterThan(90 * 1024);
    expect(bytes(big(2))).toBeLessThan(90 * 1024);
    refused(doc({ activities: big(6) }), "body");
    expect(parseRopaDocument(doc({ activities: big(2) }), NOW).activities).toHaveLength(30);
  });

  test("other measures alone are enough when none of the listed ones applies", () => {
    expect(parseRopaDocument(doc({ activities: [activity({ securityMeasures: [], otherMeasures: "A locked cabinet." })] }), NOW).activities[0]?.otherMeasures).toBe("A locked cabinet.");
  });

  test("the list of measures is the one the page offers", () => {
    expect(SECURITY_MEASURES).toEqual(["encryption_at_rest", "encryption_in_transit", "access_control", "multi_factor", "logging", "backups", "pseudonymisation", "physical_security"]);
  });
});

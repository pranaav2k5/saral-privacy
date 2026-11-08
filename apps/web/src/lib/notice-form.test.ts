import { buildRequest, emptyForm, emptyPurpose, fieldLabel, problemsFromError, type NoticeForm } from "./notice-form";
import { ApiError } from "./api";

const filled = (over: Partial<NoticeForm> = {}): NoticeForm => ({
  ...emptyForm(),
  organisationName: "  Example Controller Pvt Ltd ",
  websiteUrl: "https://example.org",
  grievanceEmail: "privacy@example.org",
  grievanceAddress: "1 Example Road, Bengaluru 560001",
  withdrawalUrl: "https://example.org/privacy#withdraw",
  rightsRequestUrl: "https://example.org/privacy#rights",
  purposes: [
    {
      ...emptyPurpose(),
      key: "analytics",
      name: "Understand how the app is used",
      description: "We count which screens are opened.",
      dataItems: "device type\n screens opened \n\n",
      retention: "12 months",
      retentionDays: "365",
      purposeCategory: "analytics, product",
      piiCategory: "device type",
    },
  ],
  ...over,
});

describe("buildRequest", () => {
  test("turns the form into the request the API takes: lists split and trimmed, numbers as numbers, empty optional fields left out", () => {
    const r = buildRequest(filled());
    expect(r).toEqual({
      ok: true,
      request: {
        language: "en",
        notice: {
          organisationName: "Example Controller Pvt Ltd",
          websiteUrl: "https://example.org",
          grievanceEmail: "privacy@example.org",
          grievanceAddress: "1 Example Road, Bengaluru 560001",
          thirdParties: [],
          processesChildrenData: false,
          withdrawalUrl: "https://example.org/privacy#withdraw",
          rightsRequestUrl: "https://example.org/privacy#rights",
        },
        purposes: [
          {
            key: "analytics",
            name: "Understand how the app is used",
            description: "We count which screens are opened.",
            dataItems: ["device type", "screens opened"],
            retention: "12 months",
            retentionDays: 365,
            purposeCategory: ["analytics", "product"],
            piiCategory: ["device type"],
            thirdPartyDisclosure: false,
          },
        ],
      },
    });
  });

  test("includes the officer's name when given, the third parties one per line, and the children's data answer", () => {
    const r = buildRequest(filled({ dpoName: " A. Officer ", thirdParties: "Example Analytics Ltd\n\nOther Ltd ", processesChildrenData: true, language: "hi" }));
    expect(r.ok && r.request.language).toBe("hi");
    expect(r.ok && r.request.notice).toMatchObject({ dpoName: "A. Officer", thirdParties: ["Example Analytics Ltd", "Other Ltd"], processesChildrenData: true });
  });

  test("a third party's name may contain a comma, because they are listed one per line; categories may be separated by commas or lines", () => {
    const base = filled({ thirdParties: "Example Analytics, Inc.\nOther Ltd" });
    const p = { ...(base.purposes[0] as NoticeForm["purposes"][number]), purposeCategory: "analytics\nproduct, research" };
    const r = buildRequest({ ...base, purposes: [p] });
    expect(r.ok && r.request.notice.thirdParties).toEqual(["Example Analytics, Inc.", "Other Ltd"]);
    expect(r.ok && r.request.purposes[0]?.purposeCategory).toEqual(["analytics", "product", "research"]);
  });

  test("a purpose that discloses to a third party carries the name; one that does not never does, even if a name was typed before", () => {
    const base = filled({ thirdParties: "Example Analytics Ltd" });
    const withName = { ...(base.purposes[0] as NoticeForm["purposes"][number]), thirdPartyDisclosure: true, thirdPartyName: "Example Analytics Ltd" };
    const a = buildRequest({ ...base, purposes: [withName] });
    expect(a.ok && a.request.purposes[0]).toMatchObject({ thirdPartyDisclosure: true, thirdPartyName: "Example Analytics Ltd" });
    const b = buildRequest({ ...base, purposes: [{ ...withName, thirdPartyDisclosure: false }] });
    expect(b.ok && "thirdPartyName" in (b.request.purposes[0] as object)).toBe(false);
  });

  test.each([
    ["organisationName", { organisationName: " " }, "notice.organisationName"],
    ["websiteUrl", { websiteUrl: "" }, "notice.websiteUrl"],
    ["grievanceEmail", { grievanceEmail: "" }, "notice.grievanceEmail"],
    ["grievanceAddress", { grievanceAddress: "" }, "notice.grievanceAddress"],
    ["withdrawalUrl", { withdrawalUrl: "" }, "notice.withdrawalUrl"],
    ["rightsRequestUrl", { rightsRequestUrl: "" }, "notice.rightsRequestUrl"],
  ])("a missing %s is reported before anything is sent", (_n, over, field) => {
    const r = buildRequest(filled(over));
    expect(r).toEqual({ ok: false, problems: [{ field, message: "is required" }] });
  });

  test.each([
    ["key", { key: "" }, "purposes[0].key", "is required"],
    ["name", { name: "" }, "purposes[0].name", "is required"],
    ["description", { description: "" }, "purposes[0].description", "is required"],
    ["data items", { dataItems: " \n " }, "purposes[0].dataItems", "is required"],
    ["retention in words", { retention: "" }, "purposes[0].retention", "is required"],
    ["purpose categories", { purposeCategory: " , " }, "purposes[0].purposeCategory", "is required"],
    ["data categories", { piiCategory: "" }, "purposes[0].piiCategory", "is required"],
    ["retention that is not a number", { retentionDays: "a year" }, "purposes[0].retentionDays", "must be a whole number of days from 0 to 36500"],
    ["retention that is not whole", { retentionDays: "1.5" }, "purposes[0].retentionDays", "must be a whole number of days from 0 to 36500"],
    ["retention that is negative", { retentionDays: "-1" }, "purposes[0].retentionDays", "must be a whole number of days from 0 to 36500"],
    ["retention over the limit", { retentionDays: "36501" }, "purposes[0].retentionDays", "must be a whole number of days from 0 to 36500"],
    ["retention left empty", { retentionDays: "" }, "purposes[0].retentionDays", "must be a whole number of days from 0 to 36500"],
    ["a disclosure with no third party chosen", { thirdPartyDisclosure: true, thirdPartyName: "" }, "purposes[0].thirdPartyName", "must name the organisation it is disclosed to"],
  ])("a purpose with %s is reported by its place", (_n, over, field, message) => {
    const base = filled();
    const r = buildRequest({ ...base, purposes: [{ ...(base.purposes[0] as NoticeForm["purposes"][number]), ...over }] });
    expect(r).toEqual({ ok: false, problems: [{ field, message }] });
  });

  test("a disclosure to someone who is not in the notice's list of third parties is reported, because the notice would not disclose it", () => {
    const base = filled({ thirdParties: "Example Analytics Ltd" });
    const p = { ...(base.purposes[0] as NoticeForm["purposes"][number]), thirdPartyDisclosure: true, thirdPartyName: "Somebody Else Ltd" };
    expect(buildRequest({ ...base, purposes: [p] })).toEqual({ ok: false, problems: [{ field: "purposes[0].thirdPartyName", message: "must be one of the third parties listed for the notice" }] });
    expect(buildRequest({ ...base, thirdParties: " Somebody Else Ltd \nExample Analytics Ltd", purposes: [p] }).ok).toBe(true);
  });

  test("zero days is a valid retention, and every problem in the form is reported at once", () => {
    const base = filled({ organisationName: "", websiteUrl: "" });
    const p = base.purposes[0] as NoticeForm["purposes"][number];
    const r = buildRequest({ ...base, purposes: [{ ...p, retentionDays: "0" }, { ...p, key: "", retentionDays: "x" }] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems.map((x) => x.field)).toEqual(["notice.organisationName", "notice.websiteUrl", "purposes[1].key", "purposes[1].retentionDays"]);
  });
});

describe("fieldLabel", () => {
  test.each([
    ["language", "Language"],
    ["notice.organisationName", "Organisation name"],
    ["notice.websiteUrl", "Website"],
    ["notice.grievanceEmail", "Grievance email"],
    ["notice.grievanceAddress", "Grievance address"],
    ["notice.dpoName", "Name of the data protection officer"],
    ["notice.thirdParties", "Third parties"],
    ["notice.processesChildrenData", "Children's data"],
    ["notice.withdrawalUrl", "Withdrawal link"],
    ["notice.rightsRequestUrl", "Rights request link"],
    ["purposes", "Purposes"],
    ["purposes[0].key", "Purpose 1: Key"],
    ["purposes[1].name", "Purpose 2: Name"],
    ["purposes[2].description", "Purpose 3: Description"],
    ["purposes[0].dataItems", "Purpose 1: Data items"],
    ["purposes[0].retention", "Purpose 1: How long, in words"],
    ["purposes[0].retentionDays", "Purpose 1: How long, in days"],
    ["purposes[0].purposeCategory", "Purpose 1: Purpose categories"],
    ["purposes[0].piiCategory", "Purpose 1: Data categories"],
    ["purposes[0].thirdPartyDisclosure", "Purpose 1: Shared with a third party"],
    ["purposes[0].thirdPartyName", "Purpose 1: Third party"],
    ["purposes[0].primaryPurpose", "Purpose 1: Primary purpose"],
    ["purposes[11].key", "Purpose 12: Key"],
    ["purposes[3]", "Purpose 4"],
    ["body", "The notice"],
    ["notice", "Notice details"],
    ["something.else", "something.else"],
    ["", "The notice"],
  ])("%s is %s", (path, label) => {
    expect(fieldLabel(path)).toBe(label);
  });
});

describe("problemsFromError", () => {
  test("uses the list the API gives when there is one", () => {
    const e = new ApiError(400, "m", { error: "invalid_request", field: "notice.websiteUrl", message: "is required", errors: [{ field: "notice.websiteUrl", message: "is required" }, { field: "notice.grievanceEmail", message: "must be an email address" }] });
    expect(problemsFromError(e)).toEqual(["Website is required.", "Grievance email must be an email address."]);
  });

  test("ignores entries in the list that are not a field with a message, and uses the ones that are", () => {
    const e = new ApiError(400, "m", { errors: [{ field: 1 }, {}, { field: "language", message: "must be one of: en, hi" }] });
    expect(problemsFromError(e)).toEqual(["Language must be one of: en, hi."]);
  });

  test("a list with nothing usable in it falls back to the single field and message, then to the message", () => {
    expect(problemsFromError(new ApiError(400, "m", { errors: [{}], field: "language", message: "must be one of: en, hi" }))).toEqual(["Language must be one of: en, hi."]);
    expect(problemsFromError(new ApiError(400, "Check what you entered and try again.", { errors: [{}] }))).toEqual(["Check what you entered and try again."]);
    expect(problemsFromError(new ApiError(400, "m", { errors: [null, "text", 7, { field: "language", message: "must be one of: en, hi" }] }))).toEqual(["Language must be one of: en, hi."]);
    expect(problemsFromError(new ApiError(400, "Check what you entered and try again.", { errors: [null] }))).toEqual(["Check what you entered and try again."]);
  });

  test("falls back to the single field and message", () => {
    const e = new ApiError(400, "m", { error: "invalid_request", field: "purposes[1].retentionDays", message: "must be a whole number of days from 0 to 36500" });
    expect(problemsFromError(e)).toEqual(["Purpose 2: How long, in days must be a whole number of days from 0 to 36500."]);
  });

  test("a refusal with only a message (a receipt that would be too large) is shown as it is", () => {
    const e = new ApiError(422, "a receipt that grants every purpose would be about 17000 characters", { error: "receipt_too_large", message: "a receipt that grants every purpose would be about 17000 characters" });
    expect(problemsFromError(e)).toEqual(["a receipt that grants every purpose would be about 17000 characters"]);
  });

  test("anything else becomes one plain sentence", () => {
    expect(problemsFromError(new ApiError(0, "We could not reach the server. Check your connection and try again."))).toEqual(["We could not reach the server. Check your connection and try again."]);
    expect(problemsFromError(new TypeError("x"))).toEqual(["Something went wrong. Try again."]);
  });
});

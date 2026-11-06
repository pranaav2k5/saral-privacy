import { validateNoticeInput } from "./input";
import { goodInput } from "./test-helpers";

const errorsFor = (raw: unknown): string[] => {
  const r = validateNoticeInput(raw);
  return r.ok ? [] : r.errors.map((e) => e.field);
};

describe("validateNoticeInput", () => {
  test("accepts a good input and returns a trimmed copy", () => {
    const raw = { ...goodInput(), organisationName: "  Example Controller Pvt Ltd  " };
    const r = validateNoticeInput(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.organisationName).toBe("Example Controller Pvt Ltd");
  });

  test("dpoName and thirdParties are optional", () => {
    const raw: Record<string, unknown> = { ...goodInput(), thirdParties: [] };
    delete raw.dpoName;
    expect(validateNoticeInput(raw).ok).toBe(true);
  });

  test.each([null, undefined, 7, "x", []])("rejects a non-object %p", (raw) => {
    expect(errorsFor(raw)).toEqual([""]);
  });

  test("reports every problem at once, with field paths", () => {
    const raw = { ...goodInput(), organisationName: "", grievanceEmail: "nope", purposes: [{ name: "x" }] };
    expect(errorsFor(raw)).toEqual(
      expect.arrayContaining([
        "organisationName",
        "grievanceEmail",
        "purposes[0].description",
        "purposes[0].dataItems",
        "purposes[0].retention",
      ]),
    );
  });

  test.each(["websiteUrl", "withdrawalUrl", "rightsRequestUrl"])("%s must be an https URL without credentials", (field) => {
    for (const bad of ["http://example.org", "javascript:alert(1)", "https://u:p@example.org", "example.org", ""]) {
      expect(errorsFor({ ...goodInput(), [field]: bad })).toContain(field);
    }
  });

  test("requires at least one purpose with at least one data item, and caps the counts", () => {
    expect(errorsFor({ ...goodInput(), purposes: [] })).toContain("purposes");
    const p = goodInput().purposes[0]!;
    expect(errorsFor({ ...goodInput(), purposes: [{ ...p, dataItems: [] }] })).toContain("purposes[0].dataItems");
    expect(errorsFor({ ...goodInput(), purposes: Array.from({ length: 31 }, () => p) })).toContain("purposes");
    expect(errorsFor({ ...goodInput(), purposes: [{ ...p, dataItems: Array.from({ length: 51 }, () => "x") }] })).toContain(
      "purposes[0].dataItems",
    );
  });

  test("list errors are worded for a person filling in a form", () => {
    const p = goodInput().purposes[0]!;
    const message = (raw: unknown, field: string): string | undefined => {
      const r = validateNoticeInput(raw);
      return r.ok ? undefined : r.errors.find((e) => e.field === field)?.message;
    };
    expect(message({ ...goodInput(), purposes: [{ ...p, dataItems: [] }] }, "purposes[0].dataItems")).toBe("is required");
    expect(message({ ...goodInput(), purposes: [{ ...p, dataItems: Array.from({ length: 51 }, () => "x") }] }, "purposes[0].dataItems")).toBe(
      "must have at most 50 items",
    );
    expect(message({ ...goodInput(), thirdParties: Array.from({ length: 51 }, () => "x") }, "thirdParties")).toBe(
      "must have at most 50 items",
    );
    expect(message({ ...goodInput(), purposes: [] }, "purposes")).toBe("is required");
  });

  test("caps field lengths", () => {
    expect(errorsFor({ ...goodInput(), organisationName: "x".repeat(201) })).toContain("organisationName");
    const p = goodInput().purposes[0]!;
    expect(errorsFor({ ...goodInput(), purposes: [{ ...p, description: "x".repeat(1001) }] })).toContain(
      "purposes[0].description",
    );
    expect(errorsFor({ ...goodInput(), thirdParties: Array.from({ length: 51 }, () => "x") })).toContain("thirdParties");
  });

  test.each(["line\nbreak", "tab\there", "nul\u0000", "bell\u0007", "‮rtl override", "isolate⁦x"])(
    "rejects control and bidi characters in %p (no structure injection into the notice)",
    (bad) => {
      expect(errorsFor({ ...goodInput(), organisationName: bad })).toContain("organisationName");
      expect(errorsFor({ ...goodInput(), thirdParties: [bad] })).toContain("thirdParties[0]");
    },
  );

  test("accepts Indic text including zero-width joiners", () => {
    const raw = { ...goodInput(), organisationName: "क्‍षेत्र सेवा प्राइवेट लिमिटेड ‌‍" };
    expect(validateNoticeInput(raw).ok).toBe(true);
  });

  test("processesChildrenData must be a boolean", () => {
    expect(errorsFor({ ...goodInput(), processesChildrenData: "yes" })).toContain("processesChildrenData");
  });

  test("does not mutate the raw input", () => {
    const raw = goodInput();
    const before = JSON.stringify(raw);
    validateNoticeInput(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });
});

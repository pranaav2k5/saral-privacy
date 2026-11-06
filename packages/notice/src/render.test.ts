import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderNotice } from "./render";
import { goodInput } from "./test-helpers";

const golden = readFileSync(join(__dirname, "golden", "notice-en.txt"), "utf8");

const EN_HEADINGS = [
  "Who we are",
  "What personal data we process and why",
  "Who we share it with",
  "Your rights and how to use them",
  "How to withdraw your consent",
  "Children's personal data",
  "How to complain",
  "About this draft",
];
const HI_HEADINGS = [
  "हम कौन हैं",
  "हम कौन-सा व्यक्तिगत डेटा और किसलिए प्रोसेस करते हैं",
  "हम इसे किसके साथ साझा करते हैं",
  "आपके अधिकार और उनका उपयोग कैसे करें",
  "अपनी सहमति वापस कैसे लें",
  "बच्चों का व्यक्तिगत डेटा",
  "शिकायत कैसे करें",
  "इस मसौदे के बारे में",
];

describe("English notice", () => {
  test("matches the golden text exactly (any wording change is deliberate)", () => {
    expect(renderNotice(goodInput(), "en").text).toBe(golden);
  });

  test("has the sections in order, and is marked as pending human review", () => {
    const n = renderNotice(goodInput(), "en");
    expect(n.language).toBe("en");
    expect(n.reviewStatus).toBe("pending-human-review");
    expect(n.sections.map((s) => s.heading)).toEqual(EN_HEADINGS);
    expect(n.title).toBe("Privacy notice: Example Controller Pvt Ltd");
    expect(n.banner).toMatch(/not legal advice/i);
  });

  test("every purpose, data item and retention period appears", () => {
    const { text } = renderNotice(goodInput(), "en");
    for (const p of goodInput().purposes) {
      for (const needle of [p.name, p.description, p.retention, ...p.dataItems]) expect(text).toContain(needle);
    }
  });

  test("no third parties renders a sentence, not an empty list", () => {
    const { text } = renderNotice({ ...goodInput(), thirdParties: [] }, "en");
    expect(text).toContain("We do not share your personal data with other organisations");
    expect(text).not.toContain("We share your personal data with:");
  });

  test("processing children's data changes the children section", () => {
    const yes = renderNotice({ ...goodInput(), processesChildrenData: true }, "en").text;
    expect(yes).toContain("verifiable consent from a parent or lawful guardian");
    expect(renderNotice(goodInput(), "en").text).not.toContain("verifiable consent");
  });

  test("omits the DPO line when no name is given", () => {
    const input = goodInput();
    delete input.dpoName;
    const { text } = renderNotice(input, "en");
    expect(text).not.toContain("Data protection officer or grievance contact");
  });
});

describe("Hindi notice", () => {
  test("has Devanagari headings in the same order and the same input values", () => {
    const n = renderNotice(goodInput(), "hi");
    expect(n.language).toBe("hi");
    expect(n.reviewStatus).toBe("pending-human-review");
    expect(n.sections.map((s) => s.heading)).toEqual(HI_HEADINGS);
    for (const v of ["Example Controller Pvt Ltd", "privacy@example.org", "https://example.org/privacy/withdraw", "Example Analytics Ltd", "Product updates"]) {
      expect(n.text).toContain(v);
    }
    expect(n.banner).toContain("मानव समीक्षा लंबित");
  });

  test("has the same structure as English: one entry per purpose, same number of sections", () => {
    const en = renderNotice(goodInput(), "en");
    const hi = renderNotice(goodInput(), "hi");
    expect(hi.sections).toHaveLength(en.sections.length);
    expect(hi.sections[1]?.body.length).toBe(en.sections[1]?.body.length);
  });

  test("children and no-sharing variants render", () => {
    const t = renderNotice({ ...goodInput(), processesChildrenData: true, thirdParties: [] }, "hi").text;
    expect(t).toContain("माता-पिता या वैध अभिभावक");
    expect(t).toContain("साझा नहीं करते");
  });
});

describe("tenant text is inert", () => {
  const hostile = "<img src=x onerror=alert(1)> {{organisationName}} **bold** `code`";

  test.each(["en", "hi"] as const)("appears verbatim and is never expanded again (%s)", (lang) => {
    const n = renderNotice({ ...goodInput(), organisationName: hostile }, lang);
    expect(n.text).toContain(hostile);
    expect(n.title).toContain(hostile);
    // The placeholder text is not replaced by the organisation name a second time.
    expect(n.text.split("{{organisationName}}").length - 1).toBe(n.text.split(hostile).length - 1);
  });

  test("a value cannot add a section: headings come only from the template", () => {
    const n = renderNotice({ ...goodInput(), organisationName: "Acme" }, "en");
    expect(n.text.match(/^## /gm)).toHaveLength(EN_HEADINGS.length);
  });

  test("does not mutate its input", () => {
    const input = goodInput();
    const before = JSON.stringify(input);
    renderNotice(input, "en");
    renderNotice(input, "hi");
    expect(JSON.stringify(input)).toBe(before);
  });
});

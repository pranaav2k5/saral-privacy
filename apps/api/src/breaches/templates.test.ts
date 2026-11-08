import { DRAFT_NOTICE, renderBoardNotification, renderPrincipalNotice, type IncidentFacts, type Organisation } from "./templates.js";

const ORG: Organisation = { name: "Example Controller Pvt Ltd", contact: "Grievance Officer", email: "privacy@example.org", address: "1 Example Road, Bengaluru 560001, IN" };
const FACTS: IncidentFacts = {
  title: "Laptop lost",
  description: "A laptop with a customer list was lost on a train.",
  discoveredAt: "2026-11-06T09:00:00.000Z",
  occurredAt: "2026-11-05T20:30:00.000Z",
  nature: ["confidentiality", "availability"],
  dataCategories: ["phone numbers", "names"],
  approxPrincipals: 120,
  likelyConsequences: "Calls from strangers.",
  measuresTaken: "The laptop was wiped remotely.",
};
const DEADLINE = "2026-11-09T09:00:00.000Z";

describe("the notification to the Board", () => {
  const text = renderBoardNotification(FACTS, ORG, DEADLINE);

  test("starts by saying it is a draft nobody has checked, and that it must be compared with the Rules and the Board's own form", () => {
    expect(text.split("\n")[0]).toBe(DRAFT_NOTICE);
    expect(DRAFT_NOTICE).toMatch(/not reviewed by a lawyer/i);
    expect(DRAFT_NOTICE).toMatch(/Board's own form/);
  });

  test("says who is reporting, what happened, and when it was found, with the time allowed", () => {
    expect(text).toContain("Organisation: Example Controller Pvt Ltd");
    expect(text).toContain("Contact: Grievance Officer, privacy@example.org");
    expect(text).toContain("Address: 1 Example Road, Bengaluru 560001, IN");
    expect(text).toContain("Laptop lost");
    expect(text).toContain("A laptop with a customer list was lost on a train.");
    expect(text).toContain("Found by the organisation: 2026-11-06 09:00 UTC");
    expect(text).toContain("It happened: 2026-11-05 20:30 UTC");
    expect(text).toContain("Time allowed from the day it was found: 72 hours, until 2026-11-09 09:00 UTC");
  });

  test("names the nature of the breach in words, the data involved, the number of people, the consequences and what was done", () => {
    expect(text).toContain("Someone who should not have seen the data saw it (confidentiality)");
    expect(text).toContain("Data was lost or could not be reached (availability)");
    expect(text).not.toContain("(integrity)");
    expect(text).toContain("- phone numbers");
    expect(text).toContain("- names");
    expect(text).toContain("Approximate number of people affected: 120");
    expect(text).toContain("Calls from strangers.");
    expect(text).toContain("The laptop was wiped remotely.");
  });

  test("says plainly what is not known instead of leaving it blank", () => {
    const t = renderBoardNotification({ ...FACTS, occurredAt: null, approxPrincipals: null }, ORG, DEADLINE);
    expect(t).toContain("It happened: not known");
    expect(t).toContain("Approximate number of people affected: not known yet");
    expect(t).not.toMatch(/undefined|null|NaN/);
  });

  test("is the same every time for the same facts, and changes when a fact changes", () => {
    expect(renderBoardNotification(FACTS, ORG, DEADLINE)).toBe(text);
    expect(renderBoardNotification({ ...FACTS, description: "Different." }, ORG, DEADLINE)).not.toBe(text);
    expect(renderBoardNotification(FACTS, { ...ORG, name: "Other Ltd" }, DEADLINE)).not.toBe(text);
  });

  test("keeps what was written exactly, line breaks included, and does not interpret it", () => {
    const t = renderBoardNotification({ ...FACTS, description: "Line one\nLine two <b>bold</b> & more" }, ORG, DEADLINE);
    expect(t).toContain("Line one\nLine two <b>bold</b> & more");
  });
});

describe("the notice to the affected people", () => {
  const text = renderPrincipalNotice(FACTS, ORG);

  test("starts with the same draft warning, and says that the organisation must put it in its own words and send it itself", () => {
    expect(text.split("\n")[0]).toBe(DRAFT_NOTICE);
    expect(text).toMatch(/Saral does not send this/);
  });

  test("tells a person in plain words what happened, what of theirs was involved, what it may mean, what was done, and who to ask", () => {
    expect(text).toContain("What happened");
    expect(text).toContain("A laptop with a customer list was lost on a train.");
    expect(text).toContain("What information was involved");
    expect(text).toContain("- phone numbers");
    expect(text).toContain("What this may mean for you");
    expect(text).toContain("Calls from strangers.");
    expect(text).toContain("What we have done");
    expect(text).toContain("The laptop was wiped remotely.");
    expect(text).toContain("Who to ask");
    expect(text).toContain("Grievance Officer, privacy@example.org");
    expect(text).toContain("1 Example Road, Bengaluru 560001, IN");
  });

  test("does not use the Board's wording or carry the internal facts a person has no use for", () => {
    expect(text).not.toMatch(/Data Protection Board/);
    expect(text).not.toMatch(/72 hours/);
    expect(text).not.toMatch(/\(confidentiality\)/);
    expect(text).not.toContain("120");
  });

  test("is the same every time for the same facts", () => {
    expect(renderPrincipalNotice(FACTS, ORG)).toBe(text);
  });
});

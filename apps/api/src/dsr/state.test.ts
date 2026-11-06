import { DSR_STATES, DSR_TYPES, allowedNext, canTransition, slaDueAt, type DsrState } from "./state.js";

const LEGAL: Record<DsrState, DsrState[]> = {
  submitted: ["identity_pending", "in_review", "rejected"],
  identity_pending: ["in_review", "rejected"],
  in_review: ["fulfilled", "rejected"],
  fulfilled: ["closed"],
  rejected: ["closed"],
  closed: [],
};

describe("the rights request state machine", () => {
  test("every legal transition is allowed and every other pair is refused (all 36 pairs)", () => {
    for (const from of DSR_STATES) {
      for (const to of DSR_STATES) {
        expect({ from, to, ok: canTransition(from, to) }).toEqual({ from, to, ok: LEGAL[from].includes(to) });
      }
    }
  });

  test("closed is final, and nothing goes back", () => {
    expect(allowedNext("closed")).toEqual([]);
    for (const to of DSR_STATES) expect(canTransition("closed", to)).toBe(false);
    expect(canTransition("fulfilled", "in_review")).toBe(false);
    expect(canTransition("rejected", "in_review")).toBe(false);
  });

  test("allowedNext lists the targets in a stable order", () => {
    expect(allowedNext("submitted")).toEqual(["identity_pending", "in_review", "rejected"]);
    expect(allowedNext("in_review")).toEqual(["fulfilled", "rejected"]);
  });

  test("the five request types are the ones the Act gives people", () => {
    expect([...DSR_TYPES]).toEqual(["access", "correction", "erasure", "nomination", "grievance"]);
  });
});

describe("slaDueAt", () => {
  const T = new Date("2026-11-06T09:30:00.123Z");

  test("is 30 days after submission, to the millisecond, for every type (a working default, not yet confirmed against the Rules)", () => {
    for (const type of DSR_TYPES) {
      expect(slaDueAt(T, type).toISOString()).toBe("2026-12-06T09:30:00.123Z");
    }
  });

  test("does not change its input", () => {
    const copy = new Date(T);
    slaDueAt(T, "access");
    expect(T.getTime()).toBe(copy.getTime());
  });

  test("works across a month and year end", () => {
    expect(slaDueAt(new Date("2026-12-15T00:00:00.000Z"), "erasure").toISOString()).toBe("2027-01-14T00:00:00.000Z");
  });
});

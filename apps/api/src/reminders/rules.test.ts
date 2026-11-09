import { BREACH_SOON_HOURS, ROPA_SOON_DAYS, breachStage, ropaStage } from "./rules.js";

const HOUR = 3_600_000;
const found = new Date("2026-11-06T09:00:00.000Z");
/** The Board's deadline for a breach found at 09:00 on the 6th is 09:00 on the 9th. */
const deadline = found.getTime() + 72 * HOUR;
const at = (msFromDeadline: number) => new Date(deadline + msFromDeadline);

describe("breachStage", () => {
  test("the soon window is 24 hours and the deadline is 72 hours after the breach was found", () => {
    expect(BREACH_SOON_HOURS).toBe(24);
  });

  test("is nothing while more than 24 hours remain", () => {
    expect(breachStage(found, at(-24 * HOUR - 1))).toBeNull();
    expect(breachStage(found, found)).toBeNull();
  });

  test("is soon from exactly 24 hours before the deadline up to the deadline itself", () => {
    expect(breachStage(found, at(-24 * HOUR))).toBe("soon");
    expect(breachStage(found, at(-1))).toBe("soon");
    expect(breachStage(found, at(0))).toBe("soon");
  });

  test("is passed once the deadline is behind, as the incident's own overdue flag is (strictly after)", () => {
    expect(breachStage(found, at(1))).toBe("passed");
    expect(breachStage(found, at(30 * 24 * HOUR))).toBe("passed");
  });
});

describe("ropaStage", () => {
  const noon = (day: string) => new Date(`${day}T12:00:00.000Z`);

  test("is nothing without a next review date", () => {
    expect(ropaStage(undefined, noon("2026-11-06"))).toBeNull();
  });

  test("the soon window is 14 days", () => {
    expect(ROPA_SOON_DAYS).toBe(14);
  });

  test("is nothing when the review is more than 14 days away, and soon from 14 days before it", () => {
    expect(ropaStage("2026-11-21", noon("2026-11-06"))).toBeNull();
    expect(ropaStage("2026-11-20", noon("2026-11-06"))).toBe("soon");
    expect(ropaStage("2026-11-07", noon("2026-11-06"))).toBe("soon");
  });

  test("a review due today is soon, not overdue, at any time of the day", () => {
    expect(ropaStage("2026-11-06", new Date("2026-11-06T00:00:00.000Z"))).toBe("soon");
    expect(ropaStage("2026-11-06", new Date("2026-11-06T23:59:59.999Z"))).toBe("soon");
  });

  test("is overdue from the day after the review date", () => {
    expect(ropaStage("2026-11-05", noon("2026-11-06"))).toBe("overdue");
    expect(ropaStage("2026-11-05", new Date("2026-11-06T00:00:00.000Z"))).toBe("overdue");
    expect(ropaStage("2020-01-01", noon("2026-11-06"))).toBe("overdue");
  });

  test("a date that is not a real day gives nothing rather than a reminder", () => {
    for (const bad of ["soon", "2026-13-01", "2026-02-30", "", "06/11/2026"]) expect(ropaStage(bad, noon("2026-11-06"))).toBeNull();
  });
});

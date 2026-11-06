import { dueLabel } from "./format";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const days = (n: number): string => new Date(NOW.getTime() + n * 86_400_000).toISOString();

describe("dueLabel", () => {
  test.each([
    [days(10), "submitted", "Due in 10 days", "ok"],
    [days(4), "in_review", "Due in 4 days", "ok"],
    [days(3), "identity_pending", "Due in 3 days", "soon"],
    [days(1), "submitted", "Due in 1 day", "soon"],
    [new Date(NOW.getTime() + 3 * 3_600_000).toISOString(), "submitted", "Due today", "soon"],
    [new Date(NOW.getTime() - 3 * 3_600_000).toISOString(), "submitted", "Overdue today", "overdue"],
    [days(-1), "in_review", "Overdue by 1 day", "overdue"],
    [days(-9), "submitted", "Overdue by 9 days", "overdue"],
  ])("%s while %s reads %p (%s)", (due, state, text, tone) => {
    expect(dueLabel(due, state as never, NOW)).toEqual({ text, tone });
  });

  test.each(["fulfilled", "rejected", "closed"])("a %s request is never due or overdue", (state) => {
    expect(dueLabel(days(-30), state as never, NOW)).toEqual({ text: "Finished", tone: "done" });
    expect(dueLabel(days(30), state as never, NOW)).toEqual({ text: "Finished", tone: "done" });
  });
});

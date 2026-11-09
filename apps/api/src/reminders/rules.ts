import { boardDeadline } from "../breaches/state.js";

/** A breach is "soon" for the last 24 hours before the Board's deadline. */
export const BREACH_SOON_HOURS = 24;
/** A review of the record of processing is "soon" for the last 14 days before its date. */
export const ROPA_SOON_DAYS = 14;

const HOUR = 3_600_000;
const DAY = 86_400_000;
const DAY_FORM = /^\d{4}-\d{2}-\d{2}$/;

export type BreachStage = "soon" | "passed";
export type RopaStage = "soon" | "overdue";

/**
 * Where a breach the Board has not been told about stands: nothing while more than 24 hours remain, "soon" from 24 hours before the
 * deadline up to and including the deadline, and "passed" after it (strictly, as the incident's own overdue flag is). The caller leaves
 * out incidents the Board has been told about.
 */
export function breachStage(discoveredAt: Date, now: Date): BreachStage | null {
  const left = boardDeadline(discoveredAt).getTime() - now.getTime();
  if (left < 0) return "passed";
  return left <= BREACH_SOON_HOURS * HOUR ? "soon" : null;
}

/**
 * Where the next review of the record stands, by UTC calendar day: nothing when there is no date (or it is not a real day) or it is more
 * than 14 days away, "soon" from 14 days before the date up to and including the day itself, and "overdue" from the day after.
 */
export function ropaStage(nextReviewDue: string | undefined, now: Date): RopaStage | null {
  if (nextReviewDue === undefined || !DAY_FORM.test(nextReviewDue)) return null;
  const due = new Date(`${nextReviewDue}T00:00:00Z`);
  if (Number.isNaN(due.getTime()) || due.toISOString().slice(0, 10) !== nextReviewDue) return null;
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const days = (due.getTime() - today) / DAY;
  if (days < 0) return "overdue";
  return days <= ROPA_SOON_DAYS ? "soon" : null;
}

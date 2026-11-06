export const DSR_TYPES = ["access", "correction", "erasure", "nomination", "grievance"] as const;
export type DsrType = (typeof DSR_TYPES)[number];

export const DSR_STATES = ["submitted", "identity_pending", "in_review", "fulfilled", "rejected", "closed"] as const;
export type DsrState = (typeof DSR_STATES)[number];

/** The only legal moves. A request never goes back, and `closed` is final. */
const NEXT: Record<DsrState, readonly DsrState[]> = {
  submitted: ["identity_pending", "in_review", "rejected"],
  identity_pending: ["in_review", "rejected"],
  in_review: ["fulfilled", "rejected"],
  fulfilled: ["closed"],
  rejected: ["closed"],
  closed: [],
};

export const allowedNext = (from: DsrState): readonly DsrState[] => NEXT[from];
export const canTransition = (from: DsrState, to: DsrState): boolean => NEXT[from].includes(to);

const DAY_MS = 86_400_000;
/** Days allowed per type. All 30 for now; a table so a type can differ once the Rules are confirmed. */
const SLA_DAYS: Record<DsrType, number> = { access: 30, correction: 30, erasure: 30, nomination: 30, grievance: 30 };

/**
 * When a request is due: 30 days after it was submitted, for every type. This is a working default. It has NOT been
 * confirmed against the Rules, and the lawyer advisor must confirm it before it is shown to customers (docs/PLAN.md D16).
 */
export function slaDueAt(submittedAt: Date, type: DsrType): Date {
  return new Date(submittedAt.getTime() + SLA_DAYS[type] * DAY_MS);
}

export const BREACH_STATES = ["reported", "signed_off", "board_notified", "closed"] as const;
export type BreachState = (typeof BREACH_STATES)[number];

/** The only legal moves. An incident never goes back, and `closed` is final. */
const NEXT: Record<BreachState, readonly BreachState[]> = {
  reported: ["signed_off"],
  signed_off: ["board_notified"],
  board_notified: ["closed"],
  closed: [],
};

export const allowedNext = (from: BreachState): readonly BreachState[] => NEXT[from];
export const canTransition = (from: BreachState, to: BreachState): boolean => NEXT[from].includes(to);

/**
 * Hours the organisation has to tell the Data Protection Board, counted from when it found out. This is the figure the plan cites for
 * Rule 7 (docs/PLAN.md section 4, item 9). The text of the Rule has NOT been read or confirmed here, and the lawyer advisor must confirm
 * the period, what it runs from, and what has to be sent, before this is shown to customers as legal advice.
 */
export const BOARD_DEADLINE_HOURS = 72;

export const boardDeadline = (discoveredAt: Date): Date => new Date(discoveredAt.getTime() + BOARD_DEADLINE_HOURS * 3_600_000);

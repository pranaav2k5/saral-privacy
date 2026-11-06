export const TYPES = ["access", "correction", "erasure", "nomination", "grievance"] as const;
export type RequestType = (typeof TYPES)[number];

export const STATES = ["submitted", "identity_pending", "in_review", "fulfilled", "rejected", "closed"] as const;
export type RequestState = (typeof STATES)[number];

/** The API's legal moves (apps/api/src/dsr/state.ts). A test reads that file and fails if this table differs. */
const NEXT: Record<RequestState, readonly RequestState[]> = {
  submitted: ["identity_pending", "in_review", "rejected"],
  identity_pending: ["in_review", "rejected"],
  in_review: ["fulfilled", "rejected"],
  fulfilled: ["closed"],
  rejected: ["closed"],
  closed: [],
};

export const nextStates = (from: RequestState): readonly RequestState[] => NEXT[from];

const STATE_LABEL: Record<RequestState, string> = {
  submitted: "New",
  identity_pending: "Checking identity",
  in_review: "In review",
  fulfilled: "Fulfilled",
  rejected: "Rejected",
  closed: "Closed",
};
const TYPE_LABEL: Record<RequestType, string> = {
  access: "Access to data",
  correction: "Correction",
  erasure: "Erasure",
  nomination: "Nomination",
  grievance: "Complaint",
};

export const stateLabel = (s: RequestState): string => STATE_LABEL[s];
export const typeLabel = (t: RequestType): string => TYPE_LABEL[t];

/** What the button that moves a request to this state says. */
export const ACTION_LABEL: Record<RequestState, string> = {
  submitted: "Reopen",
  identity_pending: "Ask for proof of identity",
  in_review: "Start review",
  fulfilled: "Mark as fulfilled",
  rejected: "Reject",
  closed: "Close",
};

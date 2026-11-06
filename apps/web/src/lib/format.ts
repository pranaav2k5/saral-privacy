import type { RequestState } from "./states";

export type Tone = "overdue" | "soon" | "ok" | "done";

const DAY = 86_400_000;
const FINISHED: readonly RequestState[] = ["fulfilled", "rejected", "closed"];
const plural = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? "" : "s"}`;

/** How long until a request is due, in words, and how urgent it is. A finished request is never due or overdue. */
export function dueLabel(dueAt: string, state: RequestState, now: Date = new Date()): { text: string; tone: Tone } {
  if (FINISHED.includes(state)) return { text: "Finished", tone: "done" };
  const diff = Date.parse(dueAt) - now.getTime();
  if (diff < 0) {
    const days = Math.floor(-diff / DAY);
    return { text: days < 1 ? "Overdue today" : `Overdue by ${plural(days, "day")}`, tone: "overdue" };
  }
  const days = Math.floor(diff / DAY);
  if (days < 1) return { text: "Due today", tone: "soon" };
  return { text: `Due in ${plural(days, "day")}`, tone: days <= 3 ? "soon" : "ok" };
}

/** A date and time in the reader's own format, e.g. for submission times. */
export const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

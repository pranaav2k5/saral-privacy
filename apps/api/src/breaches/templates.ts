export interface IncidentFacts {
  title: string;
  description: string;
  discoveredAt: string;
  occurredAt: string | null;
  nature: readonly ("confidentiality" | "integrity" | "availability")[];
  dataCategories: readonly string[];
  approxPrincipals: number | null;
  likelyConsequences: string;
  measuresTaken: string;
}

export interface Organisation {
  name: string;
  contact: string;
  email: string;
  address: string;
}

/** The first line of every draft. The text of the Rules has not been confirmed here, and nobody has reviewed these drafts. */
export const DRAFT_NOTICE =
  "DRAFT: not reviewed by a lawyer. Check it against the current Rules and the Board's own form before it is used.";

const NATURE: Record<IncidentFacts["nature"][number], string> = {
  confidentiality: "Someone who should not have seen the data saw it (confidentiality)",
  integrity: "Data was changed or damaged (integrity)",
  availability: "Data was lost or could not be reached (availability)",
};
const ORDER = ["confidentiality", "integrity", "availability"] as const;

/** `2026-11-06 09:00 UTC`: one unambiguous form for every time in a draft. */
const utc = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const bullets = (items: readonly string[]): string => items.map((x) => `- ${x}`).join("\n");

/**
 * The report to the Data Protection Board, as plain text for the officer to check and send through the Board's own channel
 * (Saral does not send it). The same facts always give the same text, which is what the sign-off records the hash of.
 */
export function renderBoardNotification(i: IncidentFacts, org: Organisation, deadlineIso: string): string {
  return [
    DRAFT_NOTICE,
    "",
    "Report of a personal data breach to the Data Protection Board",
    "",
    "1. Who is reporting",
    `Organisation: ${org.name}`,
    `Contact: ${org.contact}, ${org.email}`,
    `Address: ${org.address}`,
    "",
    "2. What happened",
    i.title,
    i.description,
    "",
    "3. When",
    `Found by the organisation: ${utc(i.discoveredAt)}`,
    `It happened: ${i.occurredAt === null ? "not known" : utc(i.occurredAt)}`,
    `Time allowed from the day it was found: 72 hours, until ${utc(deadlineIso)}`,
    "",
    "4. Nature of the breach",
    bullets(ORDER.filter((n) => i.nature.includes(n)).map((n) => NATURE[n])),
    "",
    "5. Personal data involved",
    bullets(i.dataCategories),
    `Approximate number of people affected: ${i.approxPrincipals === null ? "not known yet" : String(i.approxPrincipals)}`,
    "",
    "6. Likely consequences for the people affected",
    i.likelyConsequences,
    "",
    "7. What has been done",
    i.measuresTaken,
    "",
  ].join("\n");
}

/**
 * The message to the people affected, in plain words, for the organisation to put in its own voice and send itself (Saral does not
 * send it). It leaves out what the Board needs and a person does not.
 */
export function renderPrincipalNotice(i: IncidentFacts, org: Organisation): string {
  return [
    DRAFT_NOTICE,
    "Saral does not send this. Put it in your own words, check it is right, and send it yourselves.",
    "",
    "Subject: A security incident that involved your personal data",
    "",
    `We are writing to tell you about a security incident at ${org.name}.`,
    "",
    "What happened",
    i.description,
    "",
    "What information was involved",
    bullets(i.dataCategories),
    "",
    "What this may mean for you",
    i.likelyConsequences,
    "",
    "What we have done",
    i.measuresTaken,
    "",
    "Who to ask",
    `${org.contact}, ${org.email}`,
    org.address,
    "",
  ].join("\n");
}

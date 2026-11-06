import { BadRequestException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { canonicalNoticeText, renderNotice, validateNoticeInput, type NoticeLanguage } from "@saral/notice";
import type { PurposeDefinition } from "../consent/receipt-mapping.js";

export const LANGUAGES: readonly NoticeLanguage[] = ["en", "hi"];
const TOP = ["language", "notice", "purposes"];
const NOTICE_FIELDS = ["organisationName", "websiteUrl", "grievanceEmail", "grievanceAddress", "dpoName", "thirdParties", "processesChildrenData", "withdrawalUrl", "rightsRequestUrl"];
/** The text fields of a purpose become the notice; the rest become what its receipts say. */
const PURPOSE_FIELDS = ["key", "name", "description", "dataItems", "retention", "retentionDays", "purposeCategory", "piiCategory", "thirdPartyDisclosure", "thirdPartyName", "primaryPurpose"];
const KEY = /^[a-z][a-z0-9_]{0,62}$/;
const MAX_PURPOSES = 30;
const MAX_RETENTION_DAYS = 36_500;
// Control characters (line breaks included) and the bidirectional overrides, as in the notice package.
const FORBIDDEN = /[\p{Cc}‪-‮⁦-⁩]/u;

export interface BuiltNotice {
  language: NoticeLanguage;
  text: string;
  sha256: string;
  definitions: PurposeDefinition[];
}

interface FieldProblem {
  field: string;
  message: string;
}

function refuse(problems: FieldProblem[]): never {
  const first = problems[0] as FieldProblem;
  throw new BadRequestException({ error: "invalid_request", field: first.field, message: first.message, ...(problems.length > 1 ? { errors: problems } : {}) });
}
const fail = (field: string, message: string): never => refuse([{ field, message }]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function noUnknown(o: Record<string, unknown>, allowed: readonly string[], at: string): void {
  const extra = Object.keys(o).find((k) => !allowed.includes(k));
  if (extra !== undefined) fail(`${at}${extra}`, "is not a field of this request");
}

function textList(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 10) return fail(field, "must be a list of 1 to 10 texts");
  return (v as unknown[]).map((x) => {
    if (typeof x !== "string" || x.trim() === "" || x.length > 100 || FORBIDDEN.test(x)) return fail(field, "must be a list of 1 to 10 texts of up to 100 characters, with no line breaks");
    return x.trim();
  });
}

/**
 * Checks a request to publish a notice and builds everything that is stored: the text (from the reviewed template, so a
 * caller cannot supply text of their own), its hash, and the definition of each purpose that receipts are made from.
 * Problems are reported by the name of the request field they are in, and never repeat what was submitted.
 */
export function buildNotice(raw: unknown): BuiltNotice {
  if (!isObject(raw)) return fail("body", "must be a JSON object");
  noUnknown(raw, TOP, "");
  if (typeof raw.language !== "string" || !LANGUAGES.includes(raw.language as NoticeLanguage)) return fail("language", `must be one of: ${LANGUAGES.join(", ")}`);
  const language = raw.language as NoticeLanguage;
  if (!isObject(raw.notice)) return fail("notice", "must be a JSON object");
  noUnknown(raw.notice, NOTICE_FIELDS, "notice.");
  if (!Array.isArray(raw.purposes) || raw.purposes.length < 1 || raw.purposes.length > MAX_PURPOSES) return fail("purposes", `must be a list of 1 to ${String(MAX_PURPOSES)} purposes`);
  const purposes = raw.purposes as unknown[];
  purposes.forEach((p, i) => {
    if (!isObject(p)) fail(`purposes[${String(i)}]`, "must be a JSON object");
    noUnknown(p as Record<string, unknown>, PURPOSE_FIELDS, `purposes[${String(i)}].`);
  });
  const entries = purposes as Record<string, unknown>[];

  const checked = validateNoticeInput({
    ...raw.notice,
    purposes: entries.map((p) => ({ name: p.name, description: p.description, dataItems: p.dataItems, retention: p.retention })),
  });
  if (!checked.ok) {
    refuse(checked.errors.map((e) => ({ field: e.field.startsWith("purposes") ? e.field : `notice.${e.field}`, message: e.message })));
  }
  const notice = (checked as { ok: true; value: Parameters<typeof renderNotice>[0] }).value;

  const seen = new Set<string>();
  const definitions = entries.map((p, i): PurposeDefinition => {
    const at = `purposes[${String(i)}]`;
    if (typeof p.key !== "string" || !KEY.test(p.key)) return fail(`${at}.key`, "must be a lowercase key such as analytics");
    if (seen.has(p.key)) return fail(`${at}.key`, "is used by another purpose");
    seen.add(p.key);
    if (typeof p.retentionDays !== "number" || !Number.isInteger(p.retentionDays) || p.retentionDays < 0 || p.retentionDays > MAX_RETENTION_DAYS) {
      return fail(`${at}.retentionDays`, `must be a whole number of days from 0 to ${String(MAX_RETENTION_DAYS)}`);
    }
    const purposeCategory = textList(p.purposeCategory, `${at}.purposeCategory`);
    const piiCategory = textList(p.piiCategory, `${at}.piiCategory`);
    if (typeof p.thirdPartyDisclosure !== "boolean") return fail(`${at}.thirdPartyDisclosure`, "must be true or false");
    if (p.primaryPurpose !== undefined && typeof p.primaryPurpose !== "boolean") return fail(`${at}.primaryPurpose`, "must be true or false");
    let thirdPartyName: string | undefined;
    if (p.thirdPartyDisclosure) {
      thirdPartyName = typeof p.thirdPartyName === "string" ? p.thirdPartyName.trim() : undefined;
      if (thirdPartyName === undefined || !notice.thirdParties.includes(thirdPartyName)) {
        return fail(`${at}.thirdPartyName`, "must name an organisation listed in the notice's thirdParties, because the notice has to disclose it");
      }
    } else if (p.thirdPartyName !== undefined) {
      return fail(`${at}.thirdPartyName`, "must be left out when nothing is disclosed to a third party");
    }
    return {
      key: p.key,
      purpose: (notice.purposes[i] as { name: string }).name,
      purposeCategory,
      piiCategory,
      termination: notice.withdrawalUrl,
      retentionDays: p.retentionDays,
      thirdPartyDisclosure: p.thirdPartyDisclosure,
      ...(thirdPartyName !== undefined ? { thirdPartyName } : {}),
      ...(p.primaryPurpose !== undefined ? { primaryPurpose: p.primaryPurpose } : {}),
    };
  });

  const text = canonicalNoticeText(renderNotice(notice, language).text);
  return { language, text, sha256: createHash("sha256").update(text, "utf8").digest("hex"), definitions };
}

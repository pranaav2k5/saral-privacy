import { ApiError } from "./api";

export type NoticeLanguage = "en" | "hi";

/** What the administrator types. Lists are text (one item per line, or separated by commas) and numbers are text until checked. */
export interface PurposeForm {
  key: string;
  name: string;
  description: string;
  /** One per line. */
  dataItems: string;
  retention: string;
  retentionDays: string;
  /** Separated by commas. */
  purposeCategory: string;
  /** Separated by commas. */
  piiCategory: string;
  thirdPartyDisclosure: boolean;
  thirdPartyName: string;
}

export interface NoticeForm {
  language: NoticeLanguage;
  organisationName: string;
  websiteUrl: string;
  grievanceEmail: string;
  grievanceAddress: string;
  dpoName: string;
  /** One per line. */
  thirdParties: string;
  processesChildrenData: boolean;
  withdrawalUrl: string;
  rightsRequestUrl: string;
  purposes: PurposeForm[];
}

export interface PublishNoticeRequest {
  language: NoticeLanguage;
  notice: {
    organisationName: string;
    websiteUrl: string;
    grievanceEmail: string;
    grievanceAddress: string;
    dpoName?: string;
    thirdParties: string[];
    processesChildrenData: boolean;
    withdrawalUrl: string;
    rightsRequestUrl: string;
  };
  purposes: {
    key: string;
    name: string;
    description: string;
    dataItems: string[];
    retention: string;
    retentionDays: number;
    purposeCategory: string[];
    piiCategory: string[];
    thirdPartyDisclosure: boolean;
    thirdPartyName?: string;
  }[];
}

export interface Problem {
  field: string;
  message: string;
}

export const emptyPurpose = (): PurposeForm => ({
  key: "", name: "", description: "", dataItems: "", retention: "", retentionDays: "", purposeCategory: "", piiCategory: "",
  thirdPartyDisclosure: false, thirdPartyName: "",
});

export const emptyForm = (): NoticeForm => ({
  language: "en", organisationName: "", websiteUrl: "", grievanceEmail: "", grievanceAddress: "", dpoName: "", thirdParties: "",
  processesChildrenData: false, withdrawalUrl: "", rightsRequestUrl: "", purposes: [emptyPurpose()],
});

const lines = (s: string): string[] => s.split("\n").map((x) => x.trim()).filter((x) => x !== "");
const commas = (s: string): string[] => s.split(/[,\n]/).map((x) => x.trim()).filter((x) => x !== "");
const MAX_DAYS = 36_500;
const DAYS_MESSAGE = `must be a whole number of days from 0 to ${String(MAX_DAYS)}`;

/** Checks what can be checked without the server, so a form with a gap is turned back before anything is sent. The server checks the rest. */
export function buildRequest(f: NoticeForm): { ok: true; request: PublishNoticeRequest } | { ok: false; problems: Problem[] } {
  const problems: Problem[] = [];
  const need = (field: string, value: string): string => {
    const t = value.trim();
    if (t === "") problems.push({ field, message: "is required" });
    return t;
  };
  const organisationName = need("notice.organisationName", f.organisationName);
  const websiteUrl = need("notice.websiteUrl", f.websiteUrl);
  const grievanceEmail = need("notice.grievanceEmail", f.grievanceEmail);
  const grievanceAddress = need("notice.grievanceAddress", f.grievanceAddress);
  const withdrawalUrl = need("notice.withdrawalUrl", f.withdrawalUrl);
  const rightsRequestUrl = need("notice.rightsRequestUrl", f.rightsRequestUrl);
  const dpoName = f.dpoName.trim();
  const thirdParties = lines(f.thirdParties);

  const purposes = f.purposes.map((p, i) => {
    const at = `purposes[${String(i)}]`;
    const key = need(`${at}.key`, p.key);
    const name = need(`${at}.name`, p.name);
    const description = need(`${at}.description`, p.description);
    const dataItems = lines(p.dataItems);
    if (dataItems.length === 0) problems.push({ field: `${at}.dataItems`, message: "is required" });
    const retention = need(`${at}.retention`, p.retention);
    const days = /^\d{1,5}$/.test(p.retentionDays.trim()) ? Number(p.retentionDays.trim()) : NaN;
    if (!(days >= 0 && days <= MAX_DAYS)) problems.push({ field: `${at}.retentionDays`, message: DAYS_MESSAGE });
    const purposeCategory = commas(p.purposeCategory);
    if (purposeCategory.length === 0) problems.push({ field: `${at}.purposeCategory`, message: "is required" });
    const piiCategory = commas(p.piiCategory);
    if (piiCategory.length === 0) problems.push({ field: `${at}.piiCategory`, message: "is required" });
    const thirdPartyName = p.thirdPartyName.trim();
    if (p.thirdPartyDisclosure && thirdPartyName === "") problems.push({ field: `${at}.thirdPartyName`, message: "must name the organisation it is disclosed to" });
    else if (p.thirdPartyDisclosure && !thirdParties.includes(thirdPartyName)) problems.push({ field: `${at}.thirdPartyName`, message: "must be one of the third parties listed for the notice" });
    return {
      key, name, description, dataItems, retention, retentionDays: days, purposeCategory, piiCategory,
      thirdPartyDisclosure: p.thirdPartyDisclosure,
      ...(p.thirdPartyDisclosure ? { thirdPartyName } : {}),
    };
  });

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    request: {
      language: f.language,
      notice: {
        organisationName, websiteUrl, grievanceEmail, grievanceAddress,
        ...(dpoName !== "" ? { dpoName } : {}),
        thirdParties,
        processesChildrenData: f.processesChildrenData,
        withdrawalUrl, rightsRequestUrl,
      },
      purposes,
    },
  };
}

const NOTICE_LABELS: Record<string, string> = {
  organisationName: "Organisation name",
  websiteUrl: "Website",
  grievanceEmail: "Grievance email",
  grievanceAddress: "Grievance address",
  dpoName: "Name of the data protection officer",
  thirdParties: "Third parties",
  processesChildrenData: "Children's data",
  withdrawalUrl: "Withdrawal link",
  rightsRequestUrl: "Rights request link",
};
const PURPOSE_LABELS: Record<string, string> = {
  key: "Key",
  name: "Name",
  description: "Description",
  dataItems: "Data items",
  retention: "How long, in words",
  retentionDays: "How long, in days",
  purposeCategory: "Purpose categories",
  piiCategory: "Data categories",
  thirdPartyDisclosure: "Shared with a third party",
  thirdPartyName: "Third party",
  primaryPurpose: "Primary purpose",
};

/** The name a person knows a field by, from the path the API reports it under. */
export function fieldLabel(path: string): string {
  if (path === "" || path === "body") return "The notice";
  if (path === "language") return "Language";
  if (path === "notice") return "Notice details";
  if (path === "purposes") return "Purposes";
  const notice = /^notice\.(\w+)$/.exec(path);
  if (notice) return NOTICE_LABELS[notice[1] as string] ?? path;
  const purpose = /^purposes\[(\d+)\](?:\.(\w+))?$/.exec(path);
  if (purpose) {
    const n = `Purpose ${String(Number(purpose[1]) + 1)}`;
    if (purpose[2] === undefined) return n;
    const label = PURPOSE_LABELS[purpose[2]];
    return label === undefined ? path : `${n}: ${label}`;
  }
  return path;
}

const SOMETHING_WENT_WRONG = "Something went wrong. Try again.";

/** What to tell the administrator when publishing was refused: every problem the server named, each in words. */
export function problemsFromError(e: unknown): string[] {
  if (!(e instanceof ApiError)) return [SOMETHING_WENT_WRONG];
  const body = (e.body ?? {}) as { field?: unknown; message?: unknown; errors?: unknown };
  const say = (field: string, message: string) => `${fieldLabel(field)} ${message}.`;
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const listed = (body.errors as { field?: unknown; message?: unknown }[]).filter((x) => typeof x?.field === "string" && typeof x?.message === "string");
    if (listed.length > 0) return listed.map((x) => say(x.field as string, x.message as string));
  }
  if (typeof body.field === "string" && typeof body.message === "string") return [say(body.field, body.message)];
  return [e.message];
}

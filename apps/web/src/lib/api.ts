import type { PublishNoticeRequest } from "./notice-form";
import type { RequestState, RequestType } from "./states";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type Role = "tenant_admin" | "dpo";
export type Scope = "sdk" | "tenant_admin" | "dpo" | "auditor";

export interface SessionInfo {
  token: string;
  expiresAt: string;
  role: Role;
  /** The password is one an operator gave the person. Until it is changed the server lets the session do nothing else. */
  mustChangePassword?: boolean;
  recoveryCodes?: string[];
}

export interface RightsRequest {
  id: string;
  type: RequestType;
  state: RequestState;
  submittedAt: string;
  dueAt: string;
  overdue: boolean;
  decidedReason: string | null;
  closedAt: string | null;
  details?: string | null;
}

export type WebhookEvent = "consent.granted" | "consent.withdrawn" | "dsr.submitted" | "dsr.transitioned";

export interface Endpoint {
  id: string;
  url: string;
  events: WebhookEvent[];
  createdAt: string;
  disabledAt: string | null;
  /** `failures` when Saral switched it off after repeated failures; anything else that is disabled was the administrator's doing. */
  disabledReason?: "admin" | "failures" | null;
}

export type DeliveryState = "pending" | "delivered" | "failed";

/** One line of an endpoint's delivery log. What was sent is not part of it. */
export interface DeliveryRecord {
  id: string;
  eventType: WebhookEvent;
  state: DeliveryState;
  attempts: number;
  createdAt: string;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
}

export type BreachState = "reported" | "signed_off" | "board_notified" | "closed";
export type BreachNature = "confidentiality" | "integrity" | "availability";

/** A personal data breach incident, from the first report to the closing note. */
export interface Breach {
  id: string;
  state: BreachState;
  title: string;
  description: string;
  discoveredAt: string;
  occurredAt: string | null;
  nature: BreachNature[];
  dataCategories: string[];
  approxPrincipalsAffected: number | null;
  likelyConsequences: string;
  measuresTaken: string;
  reportedAt: string;
  reportedBy: string;
  boardDeadline: string;
  boardOverdue: boolean;
  boardNotifiedLate: boolean | null;
  signedOffAt: string | null;
  signedOffBy: string | null;
  boardNotifiedAt: string | null;
  boardReference: string | null;
  principalsNotifiedAt: string | null;
  principalsHow: string | null;
  principalsCount: number | null;
  closedAt: string | null;
  closingNote: string | null;
}

export interface BreachRequest {
  title: string;
  description: string;
  discoveredAt: string;
  occurredAt?: string;
  nature: BreachNature[];
  dataCategories: string[];
  approxPrincipalsAffected?: number;
  likelyConsequences: string;
  measuresTaken: string;
}

/** A correction: any of the fields, with `null` to clear the time it happened or the number of people. */
export type BreachPatch = Partial<Omit<BreachRequest, "occurredAt" | "approxPrincipalsAffected">> & { occurredAt?: string | null; approxPrincipalsAffected?: number | null };

export interface BreachDrafts {
  boardNotification: string;
  principalNotice: string;
  boardDeadline: string;
  /** SHA-256 of each draft. A sign-off carries them, so it is given for exactly the text that was read. */
  boardSha256: string;
  principalSha256: string;
}

/** One consent of one person, as the data protection officer sees it. */
export interface ConsentView {
  id: string;
  status: "granted" | "withdrawn" | "expired";
  grantedAt: string;
  withdrawnAt: string | null;
  collectionMethod: "web_sdk" | "api" | "dpo_entry";
  notice: { id: string; version: number; language: string };
  purposes: { key: string; granted: boolean }[];
  receiptId: string | null;
}

export interface ConsentCounts {
  active: number;
  withdrawn: number;
  expired: number;
}

export interface ConsentSummary {
  from: string;
  to: string;
  totals: ConsentCounts;
  purposes: ({ key: string } & ConsentCounts)[];
  days: { date: string; granted: number; withdrawn: number }[];
}

export interface NoticeSummary {
  id: string;
  version: number;
  language: string;
  reviewStatus: "pending-human-review" | "reviewed";
  canonicalSha256: string;
  publishedAt: string;
  purposeKeys: string[];
}

export type AuditResult =
  | { ok: true; count: number; headHash: string; firstSeqNo: string | null; lastSeqNo: string | null; merkleRoot: string }
  | { ok: false; failure: string; seqNo: string };

export interface Anchor {
  version: 1;
  tenantId: string;
  date: string;
  count: number;
  firstSeqNo: string;
  lastSeqNo: string;
  headHash: string;
  merkleRoot: string;
}

export interface Me {
  staffId: string;
  email: string | null;
  role: Role | null;
  tenantId: string;
  scopes: Scope[];
}

const FALLBACK: Record<number, string> = {
  400: "Check what you entered and try again.",
  401: "Your session has ended. Sign in again.",
  403: "You do not have access to this.",
  404: "That could not be found.",
  409: "That is not possible in the current state.",
  410: "That is no longer available.",
  422: "That could not be done as asked.",
  429: "Too many attempts. Wait a minute and try again.",
};

/** Calls the Saral API with the signed-in person's session. Every failure is an `ApiError` with words a person can read. */
export class ApiClient {
  constructor(
    private readonly base: string,
    private readonly token: () => string | undefined | Promise<string | undefined>,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = await this.token();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base.replace(/\/+$/, "")}${path}`, {
        method,
        headers,
        credentials: "omit",
        cache: "no-store",
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ApiError(0, "We could not reach the server. Check your connection and try again.");
    }
    if (res.status === 204) return undefined as T;
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new ApiError(res.status, "The server sent a reply that could not be read.");
    }
    if (!res.ok) {
      const message = (parsed as { message?: unknown } | null)?.message;
      throw new ApiError(res.status, typeof message === "string" && message !== "" ? message : (FALLBACK[res.status] ?? "Something went wrong. Try again."), parsed);
    }
    return parsed as T;
  }

  login = (tenant: string, email: string, password: string) =>
    this.request<{ challenge: string; mfa: "enroll" | "verify" }>("POST", "/v1/auth/login", { tenant, email, password });
  enroll = (challenge: string) => this.request<{ secret: string; otpauthUrl: string }>("POST", "/v1/auth/mfa/enroll", { challenge });
  verifyMfa = (challenge: string, code: string) => this.request<SessionInfo>("POST", "/v1/auth/mfa/verify", { challenge, code });
  refresh = () => this.request<SessionInfo>("POST", "/v1/auth/refresh");
  me = () => this.request<Me>("GET", "/v1/auth/me");
  /** Answers a new session: the old token, and every other session of the person, no longer work. */
  changePassword = (currentPassword: string, newPassword: string) => this.request<SessionInfo>("POST", "/v1/auth/password", { currentPassword, newPassword });

  listRequests = (f: { state?: RequestState; overdue?: boolean }) => {
    const q = new URLSearchParams();
    if (f.state) q.set("state", f.state);
    if (f.overdue) q.set("overdue", "true");
    return this.request<RightsRequest[]>("GET", `/v1/dsr${q.size ? `?${q.toString()}` : ""}`);
  };
  getRequest = (id: string) => this.request<RightsRequest>("GET", `/v1/dsr/${encodeURIComponent(id)}`);
  transition = (id: string, to: RequestState, reason?: string) =>
    this.request<RightsRequest>("POST", `/v1/dsr/${encodeURIComponent(id)}/transition`, { to, ...(reason !== undefined ? { reason } : {}) });
  revealContact = (id: string) => this.request<{ contact: string }>("POST", `/v1/dsr/${encodeURIComponent(id)}/reveal-contact`);

  verifyAudit = (date?: string) => this.request<AuditResult>("GET", `/v1/audit/verify${date ? `?date=${encodeURIComponent(date)}` : ""}`);
  anchor = (date: string) => this.request<Anchor>("GET", `/v1/audit/merkle-root?date=${encodeURIComponent(date)}`);

  listNotices = () => this.request<NoticeSummary[]>("GET", "/v1/notices");
  publishNotice = (body: PublishNoticeRequest) => this.request<NoticeSummary>("POST", "/v1/notices", body);

  listEndpoints = () => this.request<Endpoint[]>("GET", "/v1/webhook-endpoints");
  createEndpoint = (url: string, events: WebhookEvent[]) => this.request<Endpoint & { secret: string }>("POST", "/v1/webhook-endpoints", { url, events });
  disableEndpoint = (id: string) => this.request<void>("DELETE", `/v1/webhook-endpoints/${encodeURIComponent(id)}`);
  rotateSecret = (id: string) => this.request<{ id: string; secret: string }>("POST", `/v1/webhook-endpoints/${encodeURIComponent(id)}/rotate-secret`);
  listBreaches = () => this.request<Breach[]>("GET", "/v1/breaches");
  reportBreach = (r: BreachRequest) => this.request<Breach>("POST", "/v1/breaches", r);
  updateBreach = (id: string, patch: BreachPatch) => this.request<Breach>("PATCH", `/v1/breaches/${encodeURIComponent(id)}`, patch);
  breachDrafts = (id: string) => this.request<BreachDrafts>("GET", `/v1/breaches/${encodeURIComponent(id)}/drafts`);
  signOffBreach = (id: string, seen: { boardSha256: string; principalSha256: string }) => this.request<Breach>("POST", `/v1/breaches/${encodeURIComponent(id)}/sign-off`, seen);
  recordBoardNotified = (id: string, body: { notifiedAt: string; reference: string }) => this.request<Breach>("POST", `/v1/breaches/${encodeURIComponent(id)}/board-notified`, body);
  recordPrincipalsNotified = (id: string, body: { how: string; count: number }) => this.request<Breach>("POST", `/v1/breaches/${encodeURIComponent(id)}/principals-notified`, body);
  closeBreach = (id: string, note: string) => this.request<Breach>("POST", `/v1/breaches/${encodeURIComponent(id)}/close`, { note });
  /** A person's consents. The identifier goes in the body of a POST, never in an address. */
  searchConsents = (identifier: string) => this.request<{ consents: ConsentView[]; truncated: boolean }>("POST", "/v1/consents/search", { identifier });
  consentSummary = (days: number) => this.request<ConsentSummary>("GET", `/v1/consents/summary?days=${String(days)}`);
  /** The most recent deliveries of an endpoint, newest first. */
  listDeliveries = (endpointId: string) => this.request<DeliveryRecord[]>("GET", `/v1/webhook-endpoints/${encodeURIComponent(endpointId)}/deliveries`);
  /** Puts a failed delivery back in the queue. */
  redeliver = (endpointId: string, deliveryId: string) =>
    this.request<{ id: string; state: "pending" }>("POST", `/v1/webhook-endpoints/${encodeURIComponent(endpointId)}/deliveries/${encodeURIComponent(deliveryId)}/redeliver`);
}

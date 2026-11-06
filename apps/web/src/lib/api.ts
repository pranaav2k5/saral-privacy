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

  listEndpoints = () => this.request<Endpoint[]>("GET", "/v1/webhook-endpoints");
  createEndpoint = (url: string, events: WebhookEvent[]) => this.request<Endpoint & { secret: string }>("POST", "/v1/webhook-endpoints", { url, events });
  disableEndpoint = (id: string) => this.request<void>("DELETE", `/v1/webhook-endpoints/${encodeURIComponent(id)}`);
  rotateSecret = (id: string) => this.request<{ id: string; secret: string }>("POST", `/v1/webhook-endpoints/${encodeURIComponent(id)}/rotate-secret`);
}

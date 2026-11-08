import { ApiClient, ApiError } from "./api";

interface Call { url: string; init: RequestInit }

// `null` means "signed out"; `undefined` would trigger the default parameter and silently sign the client in.
function client(reply: (c: Call) => unknown, token: string | null = "st_v1.a.b") {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = reply({ url, init }) as { status?: number; body?: unknown; throws?: boolean; rawBody?: string };
    if (r.throws) throw new TypeError("Failed to fetch");
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => (r.rawBody !== undefined ? JSON.parse(r.rawBody) : r.body) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { api: new ApiClient("https://api.example.org/", () => token ?? undefined, fetchFn), calls };
}
const headers = (c: Call) => c.init.headers as Record<string, string>;

describe("ApiClient", () => {
  test("sends the session as a bearer token, never cookies, and joins the base URL without a double slash", async () => {
    const { api, calls } = client(() => ({ body: [] }));
    await api.listRequests({});
    expect(calls[0]?.url).toBe("https://api.example.org/v1/dsr");
    expect(headers(calls[0] as Call).Authorization).toBe("Bearer st_v1.a.b");
    expect(calls[0]?.init.credentials).toBe("omit");
  });

  test("asks the browser not to keep answers in its HTTP cache, since they hold personal data", async () => {
    const { api, calls } = client(() => ({ body: [] }));
    await api.listRequests({});
    expect(calls[0]?.init.cache).toBe("no-store");
  });

  test("sends no Authorization header when there is no session (sign-in itself)", async () => {
    const { api, calls } = client(() => ({ body: { challenge: "c", mfa: "verify" } }), null);
    await api.login("org", "a@example.org", "pw");
    expect(headers(calls[0] as Call).Authorization).toBeUndefined();
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ tenant: "org", email: "a@example.org", password: "pw" });
  });

  test("waits for the session to be ready before it sends (the token getter may refresh the session first)", async () => {
    const calls: Call[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    }) as unknown as typeof fetch;
    const api = new ApiClient("https://api.example.org", async () => "st_v1.fresh.token", fetchFn);
    await api.listRequests({});
    expect(headers(calls[0] as Call).Authorization).toBe("Bearer st_v1.fresh.token");
  });

  test("builds the query for the queue and encodes ids in paths", async () => {
    const { api, calls } = client(() => ({ body: [] }));
    await api.listRequests({ state: "in_review", overdue: true });
    expect(calls[0]?.url).toBe("https://api.example.org/v1/dsr?state=in_review&overdue=true");
    await api.transition("a/b c", "in_review");
    expect(calls[1]?.url).toBe("https://api.example.org/v1/dsr/a%2Fb%20c/transition");
  });

  test("turns an error response into an ApiError with its status and the server's message", async () => {
    const { api } = client(() => ({ status: 409, body: { error: "illegal_transition", message: "a request cannot move", allowed: ["closed"] } }));
    const err = (await api.transition("x", "in_review").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.message).toBe("a request cannot move");
    expect(err.body).toMatchObject({ allowed: ["closed"] });
  });

  test("a network failure is an ApiError with status 0 and a plain message", async () => {
    const { api } = client(() => ({ throws: true }));
    const err = (await api.me().catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/could not reach/i);
  });

  test("a response that is not JSON is an error, not a crash", async () => {
    const { api } = client(() => ({ rawBody: "<html>" }));
    const err = (await api.me().catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
  });

  test("an error with no usable message falls back to words about the status", async () => {
    const { api } = client(() => ({ status: 500, body: {} }));
    expect(((await api.me().catch((e: unknown) => e)) as ApiError).message).toMatch(/something went wrong/i);
    const { api: a2 } = client(() => ({ status: 401, body: { message: "invalid credentials" } }));
    expect(((await a2.me().catch((e: unknown) => e)) as ApiError).message).toBe("invalid credentials");
  });

  test("being asked to slow down shows the server's words, with how long to wait, or plain words if it gave none", async () => {
    const { api } = client(() => ({ status: 429, body: { error: "rate_limited", message: "Too many requests. Try again in 12 seconds." } }));
    expect(((await api.me().catch((e: unknown) => e)) as ApiError).message).toBe("Too many requests. Try again in 12 seconds.");
    const { api: bare } = client(() => ({ status: 429, body: {} }));
    const err = (await bare.me().catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(429);
    expect(err.message).toBe("Too many attempts. Wait a minute and try again.");
  });

  test("changing the password sends the two passwords and nothing else", async () => {
    const { api, calls } = client(() => ({ body: { token: "t", expiresAt: "x", role: "dpo" } }));
    await api.changePassword("old pass", "new pass");
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ currentPassword: "old pass", newPassword: "new pass" });
    expect(calls[0]?.url).toBe("https://api.example.org/v1/auth/password");
  });

  test("the delivery log of an endpoint is read from its own address, and a failed delivery is sent again with a POST and no body", async () => {
    const { api, calls } = client(() => ({ body: [] }));
    await api.listDeliveries("e 1");
    expect(calls[0]?.url).toBe("https://api.example.org/v1/webhook-endpoints/e%201/deliveries");
    expect(calls[0]?.init.method).toBe("GET");
    await api.redeliver("e 1", "d/2");
    expect(calls[1]?.url).toBe("https://api.example.org/v1/webhook-endpoints/e%201/deliveries/d%2F2/redeliver");
    expect(calls[1]?.init.method).toBe("POST");
    expect(calls[1]?.init.body).toBeUndefined();
  });

  test("a person's consents are searched with the identifier in a POST body and never in the address, and the summary asks for a number of days", async () => {
    const { api, calls } = client(() => ({ body: { consents: [], truncated: false } }));
    await api.searchConsents("+919810000001");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.example.org/v1/consents/search");
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ identifier: "+919810000001" });
    await api.consentSummary(7);
    expect(calls[1]?.url).toBe("https://api.example.org/v1/consents/summary?days=7");
    expect(calls[1]?.init.method).toBe("GET");
  });

  test("a 204 (disabling an endpoint) is success with no body", async () => {
    const { api } = client(() => ({ status: 204, rawBody: "" }));
    await expect(api.disableEndpoint("e1")).resolves.toBeUndefined();
  });

  test("the whole set of calls hits the documented routes", async () => {
    const { api, calls } = client(() => ({ body: {} }));
    await api.enroll("c");
    await api.verifyMfa("c", "123456");
    await api.refresh();
    await api.me();
    await api.changePassword("old pass", "new pass");
    await api.getRequest("r1");
    await api.revealContact("r1");
    await api.verifyAudit();
    await api.verifyAudit("2026-11-06");
    await api.anchor("2026-11-06");
    await api.listEndpoints();
    await api.createEndpoint("https://h.example.org/x", ["consent.granted"]);
    await api.rotateSecret("e1");
    expect(calls.map((c) => `${String(c.init.method)} ${c.url.replace("https://api.example.org", "")}`)).toEqual([
      "POST /v1/auth/mfa/enroll", "POST /v1/auth/mfa/verify", "POST /v1/auth/refresh", "GET /v1/auth/me", "POST /v1/auth/password", "GET /v1/dsr/r1",
      "POST /v1/dsr/r1/reveal-contact", "GET /v1/audit/verify", "GET /v1/audit/verify?date=2026-11-06", "GET /v1/audit/merkle-root?date=2026-11-06",
      "GET /v1/webhook-endpoints", "POST /v1/webhook-endpoints", "POST /v1/webhook-endpoints/e1/rotate-secret",
    ]);
  });
});

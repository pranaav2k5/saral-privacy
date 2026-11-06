import { act, render, screen, waitFor } from "@testing-library/react";
import { SessionProvider, useSession, STORAGE_KEY, type SessionValue } from "./session";
import type { ReactNode } from "react";
import type { SessionInfo } from "./api";

interface Call { url: string; init: RequestInit }
type Reply = { status?: number; body?: unknown; wait?: Promise<unknown> };

const NOW = Date.parse("2026-11-06T10:00:00.000Z");
const info = (over: Partial<SessionInfo> = {}): SessionInfo => ({ token: "st_v1.one.sig", expiresAt: new Date(NOW + 15 * 60_000).toISOString(), role: "dpo", ...over });

function setup(replies: Record<string, Reply | (() => Reply)> = {}) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const raw = replies[path] ?? { body: [] };
    const r = typeof raw === "function" ? raw() : raw;
    if (r.wait) await r.wait;
    const status = r.status ?? 200;
    return { ok: status < 300, status, json: async () => r.body ?? {} } as unknown as Response;
  }) as unknown as typeof fetch;
  let ctx: SessionValue | undefined;
  function Grab() {
    ctx = useSession();
    return <p data-testid="out">{`${ctx.status}|${ctx.role ?? "-"}|${ctx.notice ?? "-"}`}</p>;
  }
  render(
    <SessionProvider baseUrl="https://api.example.org" fetchFn={fetchFn} now={() => NOW}>
      <Grab />
    </SessionProvider>,
  );
  return { calls, session: () => ctx as SessionValue, out: () => screen.getByTestId("out").textContent };
}
const stored = (v: unknown) => sessionStorage.setItem(STORAGE_KEY, typeof v === "string" ? v : JSON.stringify(v));
const auth = (c: Call) => (c.init.headers as Record<string, string>).Authorization;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe("SessionProvider", () => {
  test("with nothing stored, the person is signed out", async () => {
    const t = setup();
    await waitFor(() => expect(t.out()).toBe("signedOut|-|-"));
  });

  test("a stored, unexpired session signs the person in and its token is sent", async () => {
    stored(info());
    const t = setup();
    await waitFor(() => expect(t.out()).toBe("signedIn|dpo|-"));
    await act(async () => { await t.session().api.listRequests({}); });
    expect(auth(t.calls[0] as Call)).toBe("Bearer st_v1.one.sig");
  });

  test.each([
    ["not JSON", "{nope"],
    ["an unknown role", JSON.stringify({ token: "st_v1.a.b", expiresAt: new Date(NOW + 60_000).toISOString(), role: "root" })],
    ["no token", JSON.stringify({ expiresAt: new Date(NOW + 60_000).toISOString(), role: "dpo" })],
    ["already expired", JSON.stringify(info({ expiresAt: new Date(NOW - 1000).toISOString() }))],
  ])("a stored session that is %s is discarded", async (_n, value) => {
    stored(value);
    const t = setup();
    await waitFor(() => expect(t.out()).toBe("signedOut|-|-"));
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("signing in keeps the session for this tab only, never in localStorage; signing out clears it", async () => {
    const t = setup();
    await waitFor(() => expect(t.out()).toBe("signedOut|-|-"));
    act(() => t.session().signIn(info({ role: "tenant_admin" })));
    expect(t.out()).toBe("signedIn|tenant_admin|-");
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) as string).token).toBe("st_v1.one.sig");
    expect(localStorage.length).toBe(0);
    act(() => t.session().signOut());
    expect(t.out()).toBe("signedOut|-|-");
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("the recovery codes are not kept: they are shown once and never written to storage", async () => {
    const t = setup();
    await waitFor(() => expect(t.out()).toBe("signedOut|-|-"));
    act(() => t.session().signIn(info({ recoveryCodes: ["AAAA-BBBB"] })));
    expect(sessionStorage.getItem(STORAGE_KEY)).not.toContain("AAAA-BBBB");
  });

  test("a 401 on a signed-in request signs the person out and says why", async () => {
    stored(info());
    const t = setup({ "/v1/dsr": { status: 401, body: { message: "expired" } } });
    await waitFor(() => expect(t.out()).toBe("signedIn|dpo|-"));
    await act(async () => { await t.session().api.listRequests({}).catch(() => undefined); });
    expect(t.out()).toBe("signedOut|-|Your session ended. Sign in again.");
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("a 401 from the sign-in call itself (wrong password) does not show the session-ended notice", async () => {
    const t = setup({ "/v1/auth/login": { status: 401, body: { message: "Check your details." } } });
    await waitFor(() => expect(t.out()).toBe("signedOut|-|-"));
    await act(async () => { await t.session().api.login("org", "a@example.org", "bad").catch(() => undefined); });
    expect(t.out()).toBe("signedOut|-|-");
  });

  test("a session close to expiry is refreshed before the next call, once even for simultaneous calls", async () => {
    stored(info({ expiresAt: new Date(NOW + 60_000).toISOString() }));
    const fresh = info({ token: "st_v1.two.sig", expiresAt: new Date(NOW + 15 * 60_000).toISOString() });
    const t = setup({ "/v1/auth/refresh": { body: fresh } });
    await waitFor(() => expect(t.out()).toBe("signedIn|dpo|-"));
    await act(async () => { await Promise.all([t.session().api.listRequests({}), t.session().api.listRequests({})]); });
    const refreshes = t.calls.filter((c) => c.url.endsWith("/v1/auth/refresh"));
    expect(refreshes).toHaveLength(1);
    expect(auth(refreshes[0] as Call)).toBe("Bearer st_v1.one.sig");
    const queue = t.calls.filter((c) => c.url.endsWith("/v1/dsr"));
    expect(queue.map(auth)).toEqual(["Bearer st_v1.two.sig", "Bearer st_v1.two.sig"]);
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) as string).token).toBe("st_v1.two.sig");
  });

  test("the api client keeps its identity across sign-in and refresh, so screens do not reload their data when the token changes", async () => {
    stored(info({ expiresAt: new Date(NOW + 60_000).toISOString() }));
    const t = setup({ "/v1/auth/refresh": { body: info({ token: "st_v1.two.sig" }) } });
    await waitFor(() => expect(t.out()).toBe("signedIn|dpo|-"));
    const before = t.session().api;
    await act(async () => { await t.session().api.listRequests({}); });
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) as string).token).toBe("st_v1.two.sig");
    expect(t.session().api).toBe(before);
  });

  test("a session with plenty of time left is not refreshed", async () => {
    stored(info());
    const t = setup();
    await waitFor(() => expect(t.out()).toBe("signedIn|dpo|-"));
    await act(async () => { await t.session().api.listRequests({}); });
    expect(t.calls.some((c) => c.url.endsWith("/v1/auth/refresh"))).toBe(false);
  });

  test("if the refresh is refused (for example after eight hours) the person is signed out", async () => {
    stored(info({ expiresAt: new Date(NOW + 60_000).toISOString() }));
    const t = setup({ "/v1/auth/refresh": { status: 401, body: { message: "the session has reached its limit; sign in again" } } });
    await waitFor(() => expect(t.out()).toBe("signedIn|dpo|-"));
    await act(async () => { await t.session().api.listRequests({}).catch(() => undefined); });
    expect(t.out()).toBe("signedOut|-|Your session ended. Sign in again.");
  });

  test("the client never sends cookies", async () => {
    stored(info());
    const t = setup();
    await waitFor(() => expect(t.out()).toBe("signedIn|dpo|-"));
    await act(async () => { await t.session().api.listRequests({}); });
    expect(t.calls[0]?.init.credentials).toBe("omit");
  });
});

describe("races and failures around the session", () => {
  test("the api client keeps its identity when the provider is given no clock, as in production", () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(info({ expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() })));
    const seen: unknown[] = [];
    function Grab() {
      seen.push(useSession().api);
      return null;
    }
    const fetchFn = (async () => ({ ok: true, status: 200, json: async () => [] })) as unknown as typeof fetch;
    const tree = (extra: ReactNode) => (
      <SessionProvider baseUrl="https://api.example.org" fetchFn={fetchFn}>
        <Grab />
        {extra}
      </SessionProvider>
    );
    const { rerender } = render(tree(null));
    rerender(tree(<span />));
    rerender(tree(<b />));
    expect(new Set(seen).size).toBe(1);
  });

  test("signing out while a refresh is in flight stays signed out, and the waiting call is not sent", async () => {
    stored(info({ expiresAt: new Date(NOW + 60_000).toISOString() }));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup({ "/v1/auth/refresh": { body: info({ token: "st_v1.late.sig" }), wait: gate } });
    await waitFor(() => expect(t.out()).toBe("signedIn|dpo|-"));
    let outcome: unknown;
    await act(async () => {
      outcome = t.session().api.listRequests({}).then(() => "sent", (e: unknown) => (e as Error).message);
      await Promise.resolve();
    });
    act(() => t.session().signOut());
    await act(async () => {
      release();
      await outcome;
    });
    expect(await outcome).toBe("Your session ended. Sign in again.");
    expect(t.out()).toBe("signedOut|-|-");
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(t.calls.some((c) => c.url.endsWith("/v1/dsr"))).toBe(false);
  });

  test("a late 401 for a token that is no longer current does not end the session the person has since started", async () => {
    stored(info());
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup({ "/v1/dsr": { status: 401, body: {}, wait: gate } });
    await waitFor(() => expect(t.out()).toBe("signedIn|dpo|-"));
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = t.session().api.listRequests({}).catch(() => undefined);
      await Promise.resolve();
    });
    act(() => t.session().signOut());
    act(() => t.session().signIn(info({ token: "st_v1.new.sig" })));
    await act(async () => {
      release();
      await pending;
    });
    expect(t.out()).toBe("signedIn|dpo|-");
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) as string).token).toBe("st_v1.new.sig");
  });

  test("when the browser refuses to store the session, the person is still signed in for as long as the page stays open", async () => {
    const t = setup();
    await waitFor(() => expect(t.out()).toBe("signedOut|-|-"));
    const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      act(() => t.session().signIn(info()));
      expect(t.out()).toBe("signedIn|dpo|-");
      await act(async () => { await t.session().api.listRequests({}); });
      expect(auth(t.calls[0] as Call)).toBe("Bearer st_v1.one.sig");
      act(() => t.session().signOut());
      expect(t.out()).toBe("signedOut|-|-");
    } finally {
      spy.mockRestore();
    }
  });
});

import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { SessionProvider, STORAGE_KEY } from "@/lib/session";
import type { Role } from "@/lib/api";

export interface Call { method: string; path: string; search: string; headers: Record<string, string>; body: unknown }
export type Answer = { status?: number; body?: unknown; throws?: boolean; /** The answer is held back until this settles, to test the in-flight state. */ wait?: Promise<unknown> };
export type Route = Answer | ((call: Call) => Answer);

/** Fixed clock for every dashboard test: 10:00 UTC on 6 November 2026. */
export const NOW = Date.parse("2026-11-06T10:00:00.000Z");

/**
 * Renders a screen inside a real SessionProvider whose network is a table of canned answers.
 * Keys are "METHOD /path" (or "METHOD /path?query" to match one exact query). An array answers the
 * first call with its first entry, the second with its second, and keeps repeating the last.
 * A call with no canned answer gets a 599 that names it, so a missing route fails loudly.
 */
export function renderScreen(ui: ReactElement, opts: { routes?: Record<string, Route | Route[]>; role?: Role | null; /** The signed-in person has not yet replaced the password an operator gave them. */ mustChangePassword?: boolean } = {}) {
  const calls: Call[] = [];
  const used = new Map<string, number>();
  const routes = opts.routes ?? {};
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const call: Call = {
      method,
      path: u.pathname,
      search: u.search,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const key = [`${method} ${u.pathname}${u.search}`, `${method} ${u.pathname}`].find((k) => k in routes);
    let ans: Answer;
    if (key === undefined) ans = { status: 599, body: { message: `UNMOCKED ${method} ${u.pathname}${u.search}` } };
    else {
      const r = routes[key] as Route | Route[];
      const i = used.get(key) ?? 0;
      used.set(key, i + 1);
      const one = Array.isArray(r) ? (r[Math.min(i, r.length - 1)] as Route) : r;
      ans = typeof one === "function" ? one(call) : one;
    }
    if (ans.wait) await ans.wait;
    if (ans.throws) throw new TypeError("Failed to fetch");
    const status = ans.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => ans.body ?? {} } as unknown as Response;
  }) as unknown as typeof fetch;

  sessionStorage.clear();
  if (opts.role) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ token: "st_v1.test.sig", expiresAt: new Date(NOW + 15 * 60_000).toISOString(), role: opts.role, ...(opts.mustChangePassword ? { mustChangePassword: true } : {}) }));
  }
  const view = render(
    <SessionProvider baseUrl="https://api.example.org" fetchFn={fetchFn} now={() => NOW}>
      {ui}
    </SessionProvider>,
  );
  return { ...view, calls, callsTo: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path) };
}

export type Outcome = { kind: "ok"; status: number; body: unknown } | { kind: "http"; status: number } | { kind: "network" };

/** One JSON POST with the publishable key. No cookies are sent. Never throws. */
export async function postJson(doFetch: typeof fetch, url: string, key: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<Outcome> {
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...extraHeaders },
      body: JSON.stringify(body),
      credentials: "omit",
      mode: "cors",
    });
  } catch {
    return { kind: "network" };
  }
  if (!res.ok) return { kind: "http", status: res.status };
  try {
    return { kind: "ok", status: res.status, body: await res.json() };
  } catch {
    return { kind: "http", status: res.status };
  }
}

/**
 * A random, unguessable token for one consent request. Sent as `Idempotency-Key`, it lets the same request be retried after a
 * lost response without being recorded twice. Returns undefined when no secure random source exists (then no key is sent).
 */
export function newIdempotencyKey(): string | undefined {
  const c = globalThis.crypto as Crypto | undefined;
  if (typeof c?.getRandomValues !== "function") return undefined;
  return Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type Outcome = { kind: "ok"; status: number; body: unknown } | { kind: "http"; status: number } | { kind: "network" };

/** One JSON POST with the publishable key. No cookies are sent. Never throws. */
export async function postJson(doFetch: typeof fetch, url: string, key: string, body: unknown): Promise<Outcome> {
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
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

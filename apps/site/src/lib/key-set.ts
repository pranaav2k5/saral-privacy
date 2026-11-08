import { parseJwks, type Jwks } from "./receipt-verify";

/** A real key set is a few hundred bytes. Anything near this size is not one, and is not read to the end. */
export const MAX_KEY_SET_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;

/** Reads a response body to a string, stopping and letting go of it as soon as it is larger than the limit. */
async function readLimited(res: Response): Promise<string> {
  const raw = res.headers?.get("content-length");
  if (raw !== null && raw !== undefined && Number(raw) > MAX_KEY_SET_BYTES) throw new Error("the response says it is too large");
  const reader = res.body?.getReader();
  // Where there is no stream to read (an old browser, or a test double), fall back to the parsed body: no limit can be applied there.
  if (reader === undefined) return JSON.stringify(await res.json());
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_KEY_SET_BYTES) {
      await reader.cancel();
      throw new Error("the response is too large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(all);
}

/**
 * The public key set, or null for any reason it cannot be had and used: no answer in ten seconds, an error, a response that is too large or
 * is not a key set. Nothing but the address is sent: no cookies, no body, and no cached copy is used.
 */
export async function fetchKeySet(url: string, fetchFn: typeof fetch = fetch): Promise<Jwks | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { credentials: "omit", cache: "no-store", signal: abort.signal });
    if (!res.ok) return null;
    return parseJwks(JSON.parse(await readLimited(res)));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

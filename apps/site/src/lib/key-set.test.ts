import { MAX_KEY_SET_BYTES, fetchKeySet } from "./key-set";
import { JWKS } from "@/test/receipt-fixtures";

const URL_ = "https://api.example.org/.well-known/jwks.json";
const enc = new TextEncoder();

/** A response whose body is read in the given chunks, and which records whether it was read to the end or cancelled. */
function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const state = { reads: 0, cancelled: false };
  let i = 0;
  const res = {
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body: { getReader: () => ({ read: async () => { state.reads += 1; return i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }; }, cancel: async () => { state.cancelled = true; } }) },
    json: async () => { throw new Error("must not be used when there is a stream"); },
  } as unknown as Response;
  return { res, state };
}
const fetchOf = (res: Response | (() => Promise<Response>)) => (async () => (typeof res === "function" ? res() : res)) as unknown as typeof fetch;

describe("fetching the key set", () => {
  test("reads a normal key set, asking for nothing else: no cookies, no body, no cached copy", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return streamed([enc.encode(JSON.stringify(JWKS))]).res;
    }) as unknown as typeof fetch;
    expect(await fetchKeySet(URL_, f)).toEqual(JWKS);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(URL_);
    expect(seen[0]?.init).toMatchObject({ credentials: "omit", cache: "no-store" });
    expect(seen[0]?.init?.body).toBeUndefined();
  });

  test("reads a key set that arrives in several pieces, even when a piece ends inside a character", async () => {
    const bytes = enc.encode(JSON.stringify({ keys: [{ kid: "ключ-1", kty: "RSA" }] }));
    expect(await fetchKeySet(URL_, fetchOf(streamed([bytes.slice(0, 20), bytes.slice(20, 33), bytes.slice(33)]).res))).toEqual({ keys: [{ kid: "ключ-1", kty: "RSA" }] });
  });

  test("falls back to the parsed body where there is no stream to read", async () => {
    const res = { ok: true, status: 200, json: async () => JWKS } as unknown as Response;
    expect(await fetchKeySet(URL_, fetchOf(res))).toEqual(JWKS);
  });

  test("gives nothing when the server errs, the network fails, or the body is not a key set", async () => {
    expect(await fetchKeySet(URL_, fetchOf({ ok: false, status: 500, json: async () => JWKS } as unknown as Response))).toBeNull();
    expect(await fetchKeySet(URL_, fetchOf(() => Promise.reject(new TypeError("Failed to fetch"))))).toBeNull();
    expect(await fetchKeySet(URL_, fetchOf(streamed([enc.encode("not json")]).res))).toBeNull();
    expect(await fetchKeySet(URL_, fetchOf(streamed([enc.encode('{"nope":true}')]).res))).toBeNull();
    expect(await fetchKeySet(URL_, fetchOf(streamed([enc.encode("null")]).res))).toBeNull();
  });

  test("refuses a response that says it is too big, without reading any of it", async () => {
    const { res, state } = streamed([enc.encode("{}")], { "content-length": String(MAX_KEY_SET_BYTES + 1) });
    expect(await fetchKeySet(URL_, fetchOf(res))).toBeNull();
    expect(state.reads).toBe(0);
  });

  test("stops reading a response that turns out to be too big, and lets go of it", async () => {
    const chunk = new Uint8Array(MAX_KEY_SET_BYTES / 4 + 1).fill(32);
    const { res, state } = streamed([chunk, chunk, chunk, chunk, chunk, chunk]);
    expect(await fetchKeySet(URL_, fetchOf(res))).toBeNull();
    expect(state.cancelled).toBe(true);
    expect(state.reads).toBeLessThan(6);
  });

  test("a key set exactly at the limit is accepted, one byte more is not", async () => {
    const pad = (n: number) => enc.encode(JSON.stringify({ keys: [] }).slice(0, -1) + " ".repeat(n) + "}");
    const base = JSON.stringify({ keys: [] }).length;
    expect(await fetchKeySet(URL_, fetchOf(streamed([pad(MAX_KEY_SET_BYTES - base)]).res))).toEqual({ keys: [] });
    expect(await fetchKeySet(URL_, fetchOf(streamed([pad(MAX_KEY_SET_BYTES - base + 1)]).res))).toBeNull();
  });

  test("gives up on a server that never answers", async () => {
    jest.useFakeTimers();
    try {
      const never = (async (_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
      const pending = fetchKeySet(URL_, never);
      await jest.advanceTimersByTimeAsync(10_001);
      expect(await pending).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

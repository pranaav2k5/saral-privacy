import { signToken, verifyToken, type TokenPayload } from "./session-token.js";

const KEY = new Uint8Array(32).fill(5);
const NOW = 1_800_000_000_000;
const base = (): TokenPayload => ({ purpose: "session", sub: "11111111-1111-4111-8111-111111111111", tid: "22222222-2222-4222-8222-222222222222", role: "dpo", ver: 1, iat: NOW / 1000, exp: NOW / 1000 + 900, auth: NOW / 1000 });

describe("signed tokens", () => {
  test("round trip, and the wire form starts with its prefix", () => {
    const t = signToken(KEY, base());
    expect(t.startsWith("st_")).toBe(true);
    expect(verifyToken(KEY, t, "session", NOW)).toEqual({ ok: true, payload: base() });
  });

  test("a changed payload, a changed signature, or a different key is refused", () => {
    const t = signToken(KEY, base());
    const [prefix, payload, sig] = t.split(".") as [string, string, string];
    const evil = Buffer.from(JSON.stringify({ ...base(), role: "tenant_admin" })).toString("base64url");
    expect(verifyToken(KEY, `${prefix}.${evil}.${sig}`, "session", NOW).ok).toBe(false);
    expect(verifyToken(KEY, `${prefix}.${payload}.${sig.slice(0, -2)}AA`, "session", NOW).ok).toBe(false);
    expect(verifyToken(new Uint8Array(32).fill(6), t, "session", NOW).ok).toBe(false);
  });

  test("a token is only good for the purpose it was made for (a pre-MFA challenge is not a session)", () => {
    const challenge = signToken(KEY, { ...base(), purpose: "challenge" });
    expect(verifyToken(KEY, challenge, "session", NOW).ok).toBe(false);
    expect(verifyToken(KEY, challenge, "challenge", NOW).ok).toBe(true);
    const session = signToken(KEY, base());
    expect(verifyToken(KEY, session, "challenge", NOW).ok).toBe(false);
  });

  test("expires exactly at exp, and a token from the future is refused", () => {
    const t = signToken(KEY, base());
    expect(verifyToken(KEY, t, "session", NOW + 899_000).ok).toBe(true);
    expect(verifyToken(KEY, t, "session", NOW + 900_000).ok).toBe(false);
    expect(verifyToken(KEY, t, "session", NOW - 61_000).ok).toBe(false);
  });

  test.each(["", "st_", "st_a.b", "st_a.b.c.d", "xx_a.b.c", "Bearer st_a.b.c", "st_!!!.???.***"])("malformed %p is refused without throwing", (t) => {
    expect(verifyToken(KEY, t, "session", NOW).ok).toBe(false);
  });

  test("a token with a payload that is not the expected shape is refused even with a valid signature", () => {
    const t = signToken(KEY, { ...base(), role: "root" as never });
    expect(verifyToken(KEY, t, "session", NOW).ok).toBe(false);
    expect(verifyToken(KEY, signToken(KEY, { ...base(), ver: -1 }), "session", NOW).ok).toBe(false);
  });

  test("a key shorter than 32 bytes is refused", () => {
    expect(() => signToken(new Uint8Array(16), base())).toThrow(/32 bytes/);
  });
});

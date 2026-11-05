import { generateApiKey, hashSecret, parseApiKey } from "./api-keys.js";

const PEPPER = new Uint8Array(32).fill(3);

describe("API keys", () => {
  test("a generated key parses back to its parts", () => {
    const k = generateApiKey("secret");
    expect(k.token).toMatch(/^sk_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);
    expect(parseApiKey(k.token)).toEqual({ kind: "secret", id: k.id, secret: k.secret });
    const p = generateApiKey("publishable");
    expect(p.token.startsWith("pk_")).toBe(true);
    expect(parseApiKey(p.token)?.kind).toBe("publishable");
  });

  test("the id is a UUID and keys are unique", () => {
    const a = generateApiKey("secret");
    const b = generateApiKey("secret");
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.secret).not.toBe(b.secret);
  });

  test.each(["", "sk_", "sk_abc_def", "xx_00000000000040008000000000000000_" + "a".repeat(43), "sk_" + "0".repeat(32) + "_short",
    "sk_" + "0".repeat(32) + "_" + "a".repeat(43) + "extra", "Bearer x", "sk_" + "G".repeat(32) + "_" + "a".repeat(43)])(
    "rejects a malformed token %p",
    (t) => {
      expect(parseApiKey(t)).toBeNull();
    },
  );

  test("hashSecret is a keyed HMAC: pepper-dependent, deterministic, 64 hex", () => {
    const h = hashSecret(PEPPER, "abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret(PEPPER, "abc")).toBe(h);
    expect(hashSecret(new Uint8Array(32).fill(4), "abc")).not.toBe(h);
    expect(hashSecret(PEPPER, "abd")).not.toBe(h);
  });
});

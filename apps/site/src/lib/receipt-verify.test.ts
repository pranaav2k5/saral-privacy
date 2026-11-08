import { MAX_TOKEN_CHARS, parseJwks, reasonInWords, verifyReceiptToken } from "./receipt-verify";
import { HEADER, JWKS, K, b64u, claims, keypair, sign } from "@/test/receipt-fixtures";

const good = () => sign(K.privateKey, HEADER, claims());
const fails = async (token: string, code: string, jwks: { keys: unknown[] } = JWKS) => {
  const r = await verifyReceiptToken(token, jwks);
  expect(r.ok).toBe(false);
  if (!r.ok) expect({ code: r.code, said: r.message.length > 0 }).toEqual({ code, said: true });
};

describe("a receipt that was signed by the key in the set", () => {
  test("is accepted, and says what it records in words a person can read", async () => {
    const r = await verifyReceiptToken(good(), JWKS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kid).toBe("key-1");
    expect(r.summary).toEqual({
      receiptId: "5f1d3f5e-8c61-4b1e-9d0a-0f6c1d2b3a4c",
      consentedAt: "2026-11-06T09:30:00.000Z",
      language: "en",
      controllers: ["Example Controller Pvt Ltd"],
      policyUrl: "https://example.org/privacy",
      noticeSha256: "a".repeat(64),
      services: [{
        service: "Example app",
        purposes: [
          { name: "Understand how the app is used", categories: ["analytics"], data: ["device type"], withdrawVia: "https://example.org/privacy#withdraw", sharedWith: "Example Analytics Ltd" },
          { name: null, categories: ["marketing"], data: ["email address"], withdrawVia: "https://example.org/privacy#withdraw", sharedWith: null },
        ],
      }],
    });
  });

  test("is found among several keys by its kid", async () => {
    const other = keypair(2048, "key-0");
    expect((await verifyReceiptToken(good(), { keys: [other.jwk, K.jwk] })).ok).toBe(true);
  });

  test("shows text that looks like markup as plain text, unchanged", async () => {
    const hostile = claims({ piiControllers: [{ ...claims().piiControllers[0], piiController: '<img src=x onerror=alert(1)> & "Co"' }] });
    const r = await verifyReceiptToken(sign(K.privateKey, HEADER, hostile), JWKS);
    expect(r.ok && r.summary.controllers).toEqual(['<img src=x onerror=alert(1)> & "Co"']);
  });
});

describe("a receipt that must not be accepted", () => {
  test("one whose content was changed after it was signed", async () => {
    const [h, , s] = good().split(".") as [string, string, string];
    await fails(`${h}.${b64u(JSON.stringify(claims({ consentTimestamp: 1 })))}.${s}`, "bad_signature");
  });

  test("one signed by a different key that claims the same kid", async () => {
    const forger = keypair(2048, "key-1");
    await fails(sign(forger.privateKey, HEADER, claims()), "bad_signature");
  });

  test.each([
    ["none", "none"],
    ["HS256", "HS256"],
    ["RS512", "RS512"],
    ["a missing algorithm", undefined],
  ])("one that names %s as its algorithm", async (_n, alg) => {
    await fails(sign(K.privateKey, { ...HEADER, alg }, claims()), "bad_alg");
  });

  test.each([
    ["an unknown kid", { ...HEADER, kid: "other" }],
    ["no kid", { alg: "RS256", typ: "JWT" }],
    ["a kid that is not text", { ...HEADER, kid: 7 }],
  ])("one with %s", async (_n, header) => {
    await fails(sign(K.privateKey, header, claims()), "unknown_kid");
  });

  test("one whose key is too weak, because the numbers could be broken", async () => {
    const weak = keypair(1024, "key-1");
    await fails(sign(weak.privateKey, HEADER, claims()), "weak_key", { keys: [weak.jwk] });
    await fails(good(), "weak_key", { keys: [{ ...K.jwk, e: b64u(Buffer.from([3])) }] });
  });

  test.each([
    ["a key that is not RSA", { ...K.jwk, kty: "EC" }],
    ["a key meant for encryption", { ...K.jwk, use: "enc" }],
    ["a key for another algorithm", { ...K.jwk, alg: "RS512" }],
    ["a key with no modulus", { ...K.jwk, n: undefined }],
    ["a key with a modulus that is not base64url", { ...K.jwk, n: "not base64!" }],
  ])("one checked against %s", async (_n, jwk) => {
    await fails(good(), "bad_key", { keys: [jwk] });
  });

  test("a key whose numbers are far larger than any real key is refused before anything is decoded or imported", async () => {
    let imported = 0;
    const subtle = { importKey: async () => { imported += 1; throw new Error("no"); }, verify: async () => true } as unknown as SubtleCrypto;
    // Both are valid base64url of non-zero numbers, so only the size limit, and not an error in decoding or a weak key, can refuse them.
    for (const jwk of [{ ...K.jwk, n: "B".repeat(2052) }, { ...K.jwk, e: "AQAB".repeat(5) }]) {
      const r = await verifyReceiptToken(good(), { keys: [jwk] }, subtle);
      expect(r).toMatchObject({ ok: false, code: "bad_key" });
    }
    expect(imported).toBe(0);
  });

  test("a real key is within those limits", async () => {
    expect(String(K.jwk.n).length).toBeLessThanOrEqual(2048);
    expect(String(K.jwk.e).length).toBeLessThanOrEqual(16);
  });

  test.each([
    ["nothing", ""],
    ["two parts", "aaa.bbb"],
    ["four parts", "a.b.c.d"],
    ["padding in a part", "aGVsbG8=.aGVsbG8.aGVsbG8"],
    ["characters outside base64url", "a+b/.cc.dd"],
    ["a header that is not JSON", `${b64u("not json")}.${b64u("{}")}.${b64u("x")}`],
    ["a header that is a list", `${b64u("[]")}.${b64u("{}")}.${b64u("x")}`],
    ["a payload that is not JSON", `${b64u(JSON.stringify(HEADER))}.${b64u("nope")}.${b64u("x")}`],
    // "e31" and "e30" decode to the same two bytes, so only the canonical form check tells the first from a different header.
    ["a part that decodes but is not in its canonical form", "e31.e30.AA"],
  ])("one that is %s", async (_n, token) => {
    await fails(token, "malformed");
  });

  test("one longer than any real receipt, refused before it is looked at, even if it is signed correctly", async () => {
    await fails("a".repeat(MAX_TOKEN_CHARS + 1), "malformed");
    const huge = sign(K.privateKey, HEADER, claims({ policyUrl: `https://example.org/${"x".repeat(MAX_TOKEN_CHARS)}` }));
    expect(huge.length).toBeGreaterThan(MAX_TOKEN_CHARS);
    await fails(huge, "malformed");
  });

  test("one that is correctly signed but is not a consent receipt", async () => {
    for (const bad of [{}, claims({ version: "other" }), claims({ consentReceiptID: 5 }), claims({ piiControllers: [] }), claims({ services: "x" }), claims({ consentTimestamp: "now" }), claims({ services: [{ service: "s", purposes: [{ consentType: "x" }] }] })]) {
      await fails(sign(K.privateKey, HEADER, bad), "bad_claims");
    }
  });

  test("surrounding spaces and line breaks in what was pasted do not matter, and a quoted token is not accepted", async () => {
    expect((await verifyReceiptToken(`  ${good()}\n`, JWKS)).ok).toBe(true);
    await fails(`"${good()}"`, "malformed");
  });
});

describe("the key set", () => {
  test("is accepted only if it is an object with a list of keys", () => {
    expect(parseJwks({ keys: [K.jwk] })).toEqual({ keys: [K.jwk] });
    for (const bad of [null, [], "x", {}, { keys: "x" }, { keys: [1] }, { keys: [null] }]) expect(parseJwks(bad)).toBeNull();
  });

  test("with a thousand keys is refused rather than searched", () => {
    expect(parseJwks({ keys: Array.from({ length: 1000 }, () => K.jwk) })).toBeNull();
  });
});

describe("what each refusal says", () => {
  test.each(["malformed", "bad_alg", "bad_key", "unknown_kid", "weak_key", "bad_signature", "bad_claims"] as const)("%s has words of its own", (code) => {
    expect(reasonInWords(code).length).toBeGreaterThan(20);
  });

  test("a changed or forged receipt is not described as a technical fault", () => {
    expect(reasonInWords("bad_signature")).toMatch(/changed|not issued/i);
  });
});

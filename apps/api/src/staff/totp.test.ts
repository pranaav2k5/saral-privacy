import { base32Decode, base32Encode, generateTotpSecret, hotp, otpauthUrl, verifyTotp } from "./totp.js";

// RFC 4226 appendix D (HOTP) and RFC 6238 appendix B (TOTP, SHA-1), secret "12345678901234567890", 6 digits.
const SECRET = new TextEncoder().encode("12345678901234567890");

describe("HOTP (RFC 4226 appendix D)", () => {
  test.each([
    [0, "755224"], [1, "287082"], [2, "359152"], [3, "969429"], [4, "338314"],
    [5, "254676"], [6, "287922"], [7, "162583"], [8, "399871"], [9, "520489"],
  ])("counter %i gives %s", (counter, expected) => {
    expect(hotp(SECRET, BigInt(counter))).toBe(expected);
  });
});

describe("TOTP (RFC 6238 appendix B, last six digits of the 8-digit vectors)", () => {
  test.each([
    [59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"],
  ])("at %i seconds the code is %s", (seconds, code) => {
    const r = verifyTotp(SECRET, code, seconds * 1000, -1n);
    expect(r).toEqual({ ok: true, step: BigInt(Math.floor(seconds / 30)) });
  });
});

describe("verifyTotp", () => {
  const T = 1111111109 * 1000; // step 37037036
  const STEP = 37037036n;

  test("accepts the current code and one step either side (clock drift), but not two", () => {
    expect(verifyTotp(SECRET, "081804", T, -1n)).toEqual({ ok: true, step: STEP });
    expect(verifyTotp(SECRET, "081804", T + 30_000, -1n)).toEqual({ ok: true, step: STEP }); // code from the previous step
    expect(verifyTotp(SECRET, "081804", T - 30_000, -1n)).toEqual({ ok: true, step: STEP }); // code from the next step
    expect(verifyTotp(SECRET, "081804", T + 60_000, -1n)).toEqual({ ok: false });
    expect(verifyTotp(SECRET, "081804", T - 60_000, -1n)).toEqual({ ok: false });
  });

  test("a code that was already used (or an older one) is refused: replay protection", () => {
    expect(verifyTotp(SECRET, "081804", T, STEP)).toEqual({ ok: false });
    expect(verifyTotp(SECRET, "081804", T, STEP + 1n)).toEqual({ ok: false });
    expect(verifyTotp(SECRET, "081804", T, STEP - 1n)).toEqual({ ok: true, step: STEP });
  });

  test.each(["", "12345", "1234567", "abcdef", "08180 4", "０８１８０４", " 081804", "081804 "])("rejects the malformed code %p", (code) => {
    expect(verifyTotp(SECRET, code, T, -1n)).toEqual({ ok: false });
  });

  test("the wrong code is refused", () => {
    expect(verifyTotp(SECRET, "000000", T, -1n)).toEqual({ ok: false });
  });
});

describe("Base32 (RFC 4648 section 10)", () => {
  test.each([["", ""], ["f", "MY"], ["fo", "MZXQ"], ["foo", "MZXW6"], ["foob", "MZXW6YQ"], ["fooba", "MZXW6YTB"], ["foobar", "MZXW6YTBOI"]])(
    "%p encodes to %p (no padding) and decodes back",
    (text, encoded) => {
      const bytes = new TextEncoder().encode(text);
      expect(base32Encode(bytes)).toBe(encoded);
      expect(new TextDecoder().decode(base32Decode(encoded))).toBe(text);
    },
  );

  test("decoding is case-insensitive and ignores spaces, dashes and padding; anything else throws", () => {
    expect(new TextDecoder().decode(base32Decode("mzxw 6ytb-oi=="))).toBe("foobar");
    expect(() => base32Decode("MZXW1")).toThrow();
    expect(() => base32Decode("MZ!W6")).toThrow();
  });
});

describe("secrets and the authenticator link", () => {
  test("a new secret is 20 random bytes, different each time", () => {
    const a = generateTotpSecret();
    expect(a).toHaveLength(20);
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(generateTotpSecret()).toString("hex"));
  });

  test("the otpauth link carries the secret in Base32, the issuer, six digits and a 30 second period, with the account escaped", () => {
    const url = otpauthUrl(SECRET, "Saral Privacy", "dpo@example.org");
    expect(url).toBe("otpauth://totp/Saral%20Privacy:dpo%40example.org?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Saral%20Privacy&algorithm=SHA1&digits=6&period=30");
  });
});

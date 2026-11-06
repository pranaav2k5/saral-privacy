import { GENESIS_HASH, entryHash, sha256Hex } from "./hash";

const KEY = new Uint8Array(32).fill(7);
const CANON =
  '["saral.audit",1,"11111111-1111-4111-8111-111111111111","42","2026-11-06T09:30:00.000Z","system",null,' +
  '"consent.granted","consent_records","22222222-2222-4222-8222-222222222222","' +
  "ab".repeat(32) +
  '"]';

describe("sha256Hex", () => {
  test("known answers", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("strings are hashed as UTF-8 and equal the same bytes", () => {
    expect(sha256Hex("é")).toBe(sha256Hex(new Uint8Array([0xc3, 0xa9])));
  });
});

describe("entryHash", () => {
  test("genesis hash is 64 zeros", () => {
    expect(GENESIS_HASH).toBe("0".repeat(64));
  });

  test("matches an independent HMAC-SHA256 implementation (Python hmac) over prevHash || canonical", () => {
    expect(entryHash(KEY, GENESIS_HASH, CANON)).toBe(
      "72f78d00436655ce49682bbf3f2e1e41405298053ea3397586e08d56ba37354b",
    );
  });

  test("a different key, prev hash, or canonical string changes the result", () => {
    const base = entryHash(KEY, GENESIS_HASH, CANON);
    expect(entryHash(new Uint8Array(32).fill(8), GENESIS_HASH, CANON)).not.toBe(base);
    expect(entryHash(KEY, "1".repeat(64), CANON)).not.toBe(base);
    expect(entryHash(KEY, GENESIS_HASH, CANON + " ")).not.toBe(base);
  });

  test("rejects keys shorter than 32 bytes", () => {
    expect(() => entryHash(new Uint8Array(31), GENESIS_HASH, CANON)).toThrow(/32 bytes/);
    expect(() => entryHash(new Uint8Array(0), GENESIS_HASH, CANON)).toThrow(/32 bytes/);
  });

  test.each(["", "abc", "Z".repeat(64), "A".repeat(64), "0".repeat(63), "0".repeat(65)])(
    "rejects a malformed prevHash %p",
    (bad) => {
      expect(() => entryHash(KEY, bad, CANON)).toThrow(/prevHash/);
    },
  );
});

import { decryptContact, encryptContact } from "./contact-crypto.js";

const KEY = new Uint8Array(32).fill(9);
const TENANT = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = "44444444-4444-4444-8444-444444444444";
const CONTACT = "+919876543210";

describe("contact encryption (AES-256-GCM)", () => {
  test("round trips, and the stored bytes do not contain the contact", () => {
    const sealed = encryptContact(KEY, TENANT, PRINCIPAL, CONTACT);
    expect(decryptContact(KEY, TENANT, PRINCIPAL, sealed)).toBe(CONTACT);
    expect(Buffer.from(sealed).toString("latin1")).not.toContain("9876543210");
    expect(Buffer.from(sealed).toString("hex")).not.toContain(Buffer.from(CONTACT).toString("hex"));
  });

  test("decrypts a blob sealed by an independent implementation (Python cryptography AESGCM, same layout)", () => {
    const sealed = Uint8Array.from(Buffer.from("01000102030405060708090a0bc168aafb04781cd0ab651eaee0b7ea504ff13476af13871a3b7f5d14d2", "hex"));
    expect(decryptContact(KEY, TENANT, PRINCIPAL, sealed)).toBe(CONTACT);
  });

  test("two encryptions of the same contact differ (fresh nonce every time)", () => {
    const a = Buffer.from(encryptContact(KEY, TENANT, PRINCIPAL, CONTACT)).toString("hex");
    const b = Buffer.from(encryptContact(KEY, TENANT, PRINCIPAL, CONTACT)).toString("hex");
    expect(a).not.toBe(b);
  });

  test("starts with the version byte 1, then a 12-byte nonce, and ends with a 16-byte tag", () => {
    const sealed = encryptContact(KEY, TENANT, PRINCIPAL, CONTACT);
    expect(sealed[0]).toBe(1);
    expect(sealed.length).toBe(1 + 12 + Buffer.byteLength(CONTACT) + 16);
  });

  test("any changed byte is detected", () => {
    const sealed = encryptContact(KEY, TENANT, PRINCIPAL, CONTACT);
    for (let i = 0; i < sealed.length; i++) {
      const bad = new Uint8Array(sealed);
      bad[i] = (bad[i] as number) ^ 1;
      expect(() => decryptContact(KEY, TENANT, PRINCIPAL, bad)).toThrow();
    }
  });

  test("is bound to its tenant and principal: moved to another row it does not decrypt", () => {
    const sealed = encryptContact(KEY, TENANT, PRINCIPAL, CONTACT);
    expect(() => decryptContact(KEY, TENANT, "55555555-5555-4555-8555-555555555555", sealed)).toThrow();
    expect(() => decryptContact(KEY, "22222222-2222-4222-8222-222222222222", PRINCIPAL, sealed)).toThrow();
  });

  test("the wrong key fails, and so do keys that are not 32 bytes", () => {
    const sealed = encryptContact(KEY, TENANT, PRINCIPAL, CONTACT);
    expect(() => decryptContact(new Uint8Array(32).fill(8), TENANT, PRINCIPAL, sealed)).toThrow();
    expect(() => encryptContact(new Uint8Array(16), TENANT, PRINCIPAL, CONTACT)).toThrow(/32 bytes/);
    expect(() => decryptContact(new Uint8Array(31), TENANT, PRINCIPAL, sealed)).toThrow(/32 bytes/);
  });

  test("an unknown version or truncated input is refused", () => {
    const sealed = encryptContact(KEY, TENANT, PRINCIPAL, CONTACT);
    const v2 = new Uint8Array(sealed);
    v2[0] = 2;
    expect(() => decryptContact(KEY, TENANT, PRINCIPAL, v2)).toThrow(/version/);
    expect(() => decryptContact(KEY, TENANT, PRINCIPAL, sealed.subarray(0, 20))).toThrow();
    expect(() => decryptContact(KEY, TENANT, PRINCIPAL, new Uint8Array(0))).toThrow();
  });
});

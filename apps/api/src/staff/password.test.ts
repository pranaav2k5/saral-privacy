import { PASSWORD_MAX, PASSWORD_MIN, checkPasswordPolicy, hashPassword, verifyPassword } from "./password.js";

describe("password hashing (scrypt)", () => {
  test("a hash verifies the password it was made from, and not another", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", h)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", h)).toBe(false);
    expect(await verifyPassword("", h)).toBe(false);
  }, 20000);

  test("the stored form carries pinned parameters and a random salt, so equal passwords hash differently", async () => {
    const a = await hashPassword("same password, twice 1");
    const b = await hashPassword("same password, twice 1");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
  }, 20000);

  test("a stored hash with weaker parameters, or any other shape, never verifies (no downgrade)", async () => {
    const h = await hashPassword("a long enough password");
    const parts = h.split("$");
    for (const bad of [
      ["scrypt", "1024", ...parts.slice(2)].join("$"),
      ["scrypt", "32768", "1", ...parts.slice(3)].join("$"),
      ["scrypt", "32768", "8", "16", ...parts.slice(4)].join("$"),
      ["bcrypt", ...parts.slice(1)].join("$"),
      "", "scrypt", "plaintext", h + "$extra", h.slice(0, -4),
    ]) {
      expect({ bad: bad.slice(0, 30), ok: await verifyPassword("a long enough password", bad) }).toEqual({ bad: bad.slice(0, 30), ok: false });
    }
  }, 30000);

  test("a long password is hashed whole (no silent truncation)", async () => {
    const long = "x".repeat(100);
    const h = await hashPassword(long);
    expect(await verifyPassword(long, h)).toBe(true);
    expect(await verifyPassword("x".repeat(99) + "y", h)).toBe(false);
  }, 20000);
});

describe("password policy", () => {
  test("needs at least 12 characters and at most 128", () => {
    expect(PASSWORD_MIN).toBe(12);
    expect(PASSWORD_MAX).toBe(128);
    expect(checkPasswordPolicy("short", "a@example.org")).toMatch(/at least 12/);
    expect(checkPasswordPolicy("x".repeat(129), "a@example.org")).toMatch(/at most 128/);
    expect(checkPasswordPolicy("xyzxyzxyzxyz", "a@example.org")).toBeNull();
  });

  test("may not be the email address or its local part, in any case, and not a single repeated character", () => {
    expect(checkPasswordPolicy("dpo@example.org", "dpo@example.org")).toMatch(/email/);
    expect(checkPasswordPolicy("DPO@EXAMPLE.ORG", "dpo@example.org")).toMatch(/email/);
    expect(checkPasswordPolicy("aaaaaaaaaaaa", "dpo@example.org")).toMatch(/repeat/);
  });
});

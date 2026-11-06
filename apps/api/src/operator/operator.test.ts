import { checkPasswordPolicy } from "../staff/password.js";
import { generatePassword } from "./operator.js";

describe("generatePassword", () => {
  test("is long enough for the password policy, so an operator never hands out a password the API would refuse", () => {
    for (let i = 0; i < 20; i++) expect(checkPasswordPolicy(generatePassword(), "someone@example.org")).toBeNull();
  });

  test("is different every time and uses only characters that survive being copied from a terminal", () => {
    const seen = new Set(Array.from({ length: 50 }, generatePassword));
    expect(seen.size).toBe(50);
    for (const p of seen) expect(p).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });
});

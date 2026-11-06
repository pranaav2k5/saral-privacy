import { checkPasswordPolicy } from "../staff/password.js";
import type pg from "pg";
import { generatePassword, revokeKey } from "./operator.js";

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

describe("revokeKey when another operator revokes the same key at the same moment", () => {
  const TENANT = "11111111-1111-4111-8111-111111111111";
  const KEY = "22222222-2222-4222-8222-222222222222";
  /** A connection that finds the key active when it looks, and finds the update has nothing left to change. */
  function raced(updateRows: number) {
    const sql: string[] = [];
    const client = {
      query: async (text: string) => {
        sql.push(text);
        if (text.startsWith("SELECT id FROM tenants")) return { rows: [{ id: TENANT }], rowCount: 1 };
        if (text.startsWith("SELECT revoked_at")) return { rows: [{ revoked_at: null }], rowCount: 1 };
        return { rows: [], rowCount: updateRows };
      },
    } as unknown as pg.ClientBase;
    return { client, sql };
  }

  test("reports a revocation it made", async () => {
    expect(await revokeKey(raced(1).client, { slug: "acme", id: KEY })).toBe("revoked");
  });

  test("does not claim a revocation it did not make", async () => {
    expect(await revokeKey(raced(0).client, { slug: "acme", id: KEY })).toBe("already");
  });
});

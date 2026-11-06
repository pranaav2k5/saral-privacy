import { createHmac, randomUUID } from "node:crypto";
import type pg from "pg";
import { encryptContact } from "../crypto/contact-crypto.js";
import type { KeyProvider } from "../keys/key-provider.js";
import { checkPasswordPolicy, hashPassword } from "./password.js";
import type { StaffRole } from "./session-token.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const STAFF_ROLES: readonly StaffRole[] = ["tenant_admin", "dpo"];

/** Trimmed and lower-cased, or null if it is not an email address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  return e.length <= 254 && EMAIL.test(e) ? e : null;
}

/** The lookup index for an email address: an HMAC, so the address itself is not needed to find a person. */
export function emailBlind(keys: KeyProvider, tenantId: string, email: string): string {
  return createHmac("sha256", keys.staffIndexKey()).update(JSON.stringify(["saral.staff.email", email, tenantId])).digest("hex");
}

/** The index of a recovery code. Bound to the person, so a code cannot be moved to another account. */
export function recoveryCodeHash(keys: KeyProvider, tenantId: string, staffId: string, code: string): string {
  return createHmac("sha256", keys.staffIndexKey()).update(JSON.stringify(["saral.staff.recovery", tenantId, staffId, code.toLowerCase()])).digest("hex");
}

export interface CreateStaffInput {
  tenantId: string;
  email: string;
  password: string;
  role: StaffRole;
}

/**
 * Creates a staff account through an operator connection (the API role cannot create staff). The password is checked against
 * the policy and hashed with scrypt; the email address is sealed and indexed. Returns the new staff id.
 */
export async function createStaffUser(client: pg.ClientBase, keys: KeyProvider, input: CreateStaffInput): Promise<string> {
  if (!STAFF_ROLES.includes(input.role)) throw new Error(`role must be one of: ${STAFF_ROLES.join(", ")}`);
  const email = normalizeEmail(input.email);
  if (email === null) throw new Error("email must be an email address");
  const problem = checkPasswordPolicy(input.password, email);
  if (problem !== null) throw new Error(`password ${problem}`);
  const id = randomUUID();
  await client.query(
    "INSERT INTO staff_users (id, tenant_id, email_blind, email_sealed, role, password_hash) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, input.tenantId, emailBlind(keys, input.tenantId, email), Buffer.from(encryptContact(keys.contactKey(), input.tenantId, `email:${id}`, email)), input.role, await hashPassword(input.password)],
  );
  return id;
}

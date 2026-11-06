import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { KeyProvider } from "../keys/key-provider.js";
import { hashPassword } from "../staff/password.js";
import { createStaffUser, emailBlind, normalizeEmail } from "../staff/staff-admin.js";
import type { StaffRole } from "../staff/session-token.js";

/** A problem with what the operator asked for. Its message is written to be shown as it is. */
export class OperatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorError";
  }
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UNIQUE_VIOLATION = "23505";
const isUnique = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: unknown }).code === UNIQUE_VIOLATION;

/** 24 characters from 18 random bytes: long enough for the password policy, and safe to copy from a terminal. */
export const generatePassword = (): string => randomBytes(18).toString("base64url");

export async function createTenant(client: pg.ClientBase, input: { name: string; slug: string; id: string }): Promise<void> {
  if (input.name.length < 1 || input.name.length > 200) throw new OperatorError("The name must be 1 to 200 characters.");
  if (!SLUG.test(input.slug)) throw new OperatorError("The short name must be lowercase letters, digits and dashes, starting with a letter or digit, up to 63 characters.");
  try {
    await client.query("INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)", [input.id, input.name, input.slug]);
  } catch (e) {
    if (isUnique(e)) throw new OperatorError(`An organisation with the short name "${input.slug}" already exists.`);
    throw e;
  }
}

async function tenantIdOf(client: pg.ClientBase, slug: string): Promise<string> {
  const r = await client.query<{ id: string }>("SELECT id FROM tenants WHERE slug = $1", [slug]);
  const row = r.rows[0];
  if (!row) throw new OperatorError(`There is no organisation with the short name "${slug}".`);
  return row.id;
}

function emailOf(raw: string): string {
  const email = normalizeEmail(raw);
  if (email === null) throw new OperatorError("The email must be an email address.");
  return email;
}

async function findStaff(client: pg.ClientBase, keys: KeyProvider, slug: string, rawEmail: string) {
  const email = emailOf(rawEmail);
  const tenantId = await tenantIdOf(client, slug);
  const r = await client.query<{ id: string; disabled_at: Date | null }>("SELECT id, disabled_at FROM staff_users WHERE tenant_id = $1 AND email_blind = $2", [tenantId, emailBlind(keys, tenantId, email)]);
  const row = r.rows[0];
  if (!row) throw new OperatorError(`There is no account for ${email} in "${slug}".`);
  return { tenantId, id: row.id, email, disabled: row.disabled_at !== null };
}

/** Makes an account with a generated password, which the caller shows once. */
export async function createStaff(client: pg.ClientBase, keys: KeyProvider, input: { slug: string; email: string; role: string }): Promise<{ id: string; email: string; password: string }> {
  const tenantId = await tenantIdOf(client, input.slug);
  const password = generatePassword();
  let id: string;
  try {
    id = await createStaffUser(client, keys, { tenantId, email: input.email, password, role: input.role as StaffRole });
  } catch (e) {
    if (isUnique(e)) throw new OperatorError(`${emailOf(input.email)} already has an account in "${input.slug}".`);
    if (e instanceof Error && /^(role|email|password) /.test(e.message)) throw new OperatorError(`The ${e.message}.`);
    throw e;
  }
  return { id, email: emailOf(input.email), password };
}

/**
 * Gives the person a new password, ends every session, clears a lock, and removes the authenticator and recovery codes, so
 * they set up an authenticator again at their next sign-in. A disabled account must be enabled first.
 */
export async function resetStaff(client: pg.ClientBase, keys: KeyProvider, input: { slug: string; email: string }): Promise<{ email: string; password: string }> {
  const who = await findStaff(client, keys, input.slug, input.email);
  if (who.disabled) throw new OperatorError(`The account for ${who.email} is disabled. Enable it first.`);
  const password = generatePassword();
  const hash = await hashPassword(password);
  await client.query("BEGIN");
  try {
    await client.query(
      `UPDATE staff_users SET password_hash = $3, totp_secret_sealed = NULL, totp_confirmed_at = NULL, last_totp_step = -1,
         failed_attempts = 0, locked_until = NULL, session_version = session_version + 1
       WHERE tenant_id = $1 AND id = $2`,
      [who.tenantId, who.id, hash],
    );
    await client.query("DELETE FROM staff_recovery_codes WHERE tenant_id = $1 AND staff_id = $2", [who.tenantId, who.id]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
  return { email: who.email, password };
}

/** Blocks sign-in and ends every session of the account. */
export async function disableStaff(client: pg.ClientBase, keys: KeyProvider, input: { slug: string; email: string }): Promise<string> {
  const who = await findStaff(client, keys, input.slug, input.email);
  await client.query("UPDATE staff_users SET disabled_at = coalesce(disabled_at, now()), session_version = session_version + 1 WHERE tenant_id = $1 AND id = $2", [who.tenantId, who.id]);
  return who.email;
}

/** Allows sign-in again with the same password. Sessions that were ended stay ended. */
export async function enableStaff(client: pg.ClientBase, keys: KeyProvider, input: { slug: string; email: string }): Promise<string> {
  const who = await findStaff(client, keys, input.slug, input.email);
  await client.query("UPDATE staff_users SET disabled_at = NULL, session_version = session_version + 1 WHERE tenant_id = $1 AND id = $2", [who.tenantId, who.id]);
  return who.email;
}

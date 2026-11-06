import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { ReceiptError, buildReceiptClaims, type PiiController } from "@saral/receipts";
import type pg from "pg";
import { issueApiKey, type ApiKeyKind, type Scope } from "../auth/api-keys.js";
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

const SCOPES: readonly Scope[] = ["sdk", "tenant_admin", "dpo", "auditor"];
/** What a browser sends as `Origin`: lowercase scheme and host, no path. Plain http is only for local development. */
const ORIGIN = /^(https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?|http:\/\/localhost(:\d{1,5})?)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface IssuedKey {
  id: string;
  token: string;
  scopes: Scope[];
}

/** Makes an API key and returns its token, which the caller shows once. Only a keyed hash of the secret is stored. */
export async function issueKey(
  client: pg.ClientBase,
  keys: KeyProvider,
  input: { slug: string; kind: string; name: string; scopes?: string | undefined; origins?: string | undefined },
): Promise<IssuedKey> {
  if (input.kind !== "publishable" && input.kind !== "secret") throw new OperatorError("The kind must be publishable or secret.");
  const kind: ApiKeyKind = input.kind;
  if (input.name.length < 1 || input.name.length > 100) throw new OperatorError("The name must be 1 to 100 characters.");
  let scopes: Scope[] = ["sdk"];
  if (input.scopes !== undefined) {
    if (kind === "publishable") throw new OperatorError("A publishable key always has the sdk scope; do not give --scopes for it.");
    const given = input.scopes.split(",");
    if (given.some((g) => !SCOPES.includes(g as Scope)) || new Set(given).size !== given.length) {
      throw new OperatorError(`The scopes must be a comma-separated list from ${SCOPES.join(", ")}, with none repeated.`);
    }
    scopes = given as Scope[];
  }
  let origins: string[] = [];
  if (input.origins !== undefined) {
    if (kind === "secret") throw new OperatorError("Allowed origins are for publishable keys only.");
    origins = [...new Set(input.origins.split(","))];
    const wrong = origins.find((o) => !ORIGIN.test(o));
    if (wrong !== undefined) {
      throw new OperatorError(`"${wrong}" is not an allowed origin. Use https://host, or http://localhost for development, in lowercase, with no path or wildcard.`);
    }
  }
  const tenantId = await tenantIdOf(client, input.slug);
  const issued = await issueApiKey(client, keys.apiKeyPepper(), { tenantId, kind, scopes, name: input.name, allowedOrigins: origins });
  return { id: issued.id, token: issued.token, scopes };
}

export interface KeyRow {
  id: string;
  kind: ApiKeyKind;
  scopes: Scope[];
  name: string;
  origins: string[];
  createdAt: string;
  revokedAt: string | null;
}

/** Everything about the organisation's keys except the secrets, which are not kept. */
export async function listKeys(client: pg.ClientBase, input: { slug: string }): Promise<KeyRow[]> {
  const tenantId = await tenantIdOf(client, input.slug);
  const r = await client.query<{ id: string; kind: ApiKeyKind; scopes: Scope[]; name: string; allowed_origins: string[]; created_at: Date; revoked_at: Date | null }>(
    "SELECT id, kind, scopes, name, allowed_origins, created_at, revoked_at FROM api_keys WHERE tenant_id = $1 ORDER BY created_at, id",
    [tenantId],
  );
  return r.rows.map((k) => ({
    id: k.id, kind: k.kind, scopes: k.scopes, name: k.name, origins: k.allowed_origins,
    createdAt: k.created_at.toISOString(), revokedAt: k.revoked_at === null ? null : k.revoked_at.toISOString(),
  }));
}

/** Stops the key from working at once. Revoking again changes nothing and keeps the first time. */
export async function revokeKey(client: pg.ClientBase, input: { slug: string; id: string }): Promise<"revoked" | "already"> {
  if (!UUID.test(input.id)) throw new OperatorError("The id must be a key id, as shown by key:list.");
  const tenantId = await tenantIdOf(client, input.slug);
  const r = await client.query<{ revoked_at: Date | null }>("SELECT revoked_at FROM api_keys WHERE tenant_id = $1 AND id = $2", [tenantId, input.id]);
  const row = r.rows[0];
  if (!row) throw new OperatorError(`There is no key with that id in "${input.slug}".`);
  if (row.revoked_at !== null) return "already";
  await client.query("UPDATE api_keys SET revoked_at = now() WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL", [tenantId, input.id]);
  return "revoked";
}

const PROFILE_FIELDS = ["controller", "policyUrl", "service"];
const MAX_PROFILE_BYTES = 100_000;

/**
 * Sets who the organisation is as a data fiduciary, which every consent receipt carries. The profile is checked by building a
 * sample receipt from it, so a profile that is saved is one the API can sign receipts with.
 */
export async function setProfile(client: pg.ClientBase, input: { slug: string; file: string }): Promise<void> {
  let text: string;
  try {
    if ((await stat(input.file)).size > MAX_PROFILE_BYTES) throw new OperatorError("The profile file is too large (over 100 KB).");
    text = await readFile(input.file, "utf8");
  } catch (e) {
    if (e instanceof OperatorError) throw e;
    throw new OperatorError(`Cannot read the file "${input.file}".`);
  }
  let profile: unknown;
  try {
    profile = JSON.parse(text);
  } catch {
    throw new OperatorError("The profile file is not valid JSON.");
  }
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) throw new OperatorError("The profile must be a JSON object with controller, policyUrl and service.");
  const p = profile as Record<string, unknown>;
  const unknown = Object.keys(p).find((k) => !PROFILE_FIELDS.includes(k));
  if (unknown !== undefined) throw new OperatorError(`The profile has an unknown field "${unknown}". The fields are ${PROFILE_FIELDS.join(", ")}.`);
  if (typeof p.controller !== "object" || p.controller === null || Array.isArray(p.controller)) {
    throw new OperatorError("The profile needs a controller: an object with piiController, contact, address, email and phone.");
  }
  try {
    buildReceiptClaims({
      receiptId: "00000000-0000-4000-8000-000000000001",
      principalId: "00000000-0000-4000-8000-000000000002",
      consentedAt: new Date(),
      collectionMethod: "web form",
      controller: p.controller as PiiController,
      policyUrl: p.policyUrl as string,
      service: p.service as string,
      purposes: [{ purpose: "sample", consentType: "EXPLICIT", purposeCategory: ["sample"], piiCategory: ["sample"], termination: "https://example.org/withdraw", thirdPartyDisclosure: false }],
    });
  } catch (e) {
    if (e instanceof ReceiptError) throw new OperatorError(`The profile cannot be used for receipts: ${e.message}`);
    throw e;
  }
  const tenantId = await tenantIdOf(client, input.slug);
  await client.query("UPDATE tenants SET profile = $2 WHERE id = $1", [tenantId, JSON.stringify(profile)]);
}

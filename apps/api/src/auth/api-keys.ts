import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";

export type ApiKeyKind = "publishable" | "secret";
export type Scope = "sdk" | "tenant_admin" | "dpo" | "auditor";

const PREFIX: Record<ApiKeyKind, string> = { publishable: "pk", secret: "sk" };
const TOKEN = /^(pk|sk)_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;

export interface ParsedApiKey {
  kind: ApiKeyKind;
  /** The key's UUID. */
  id: string;
  secret: string;
}

/** `sk_<uuid without dashes>_<43 base64url characters>` (a publishable key starts with `pk_`). */
export function generateApiKey(kind: ApiKeyKind): { id: string; secret: string; token: string } {
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  return { id, secret, token: `${PREFIX[kind]}_${id.replaceAll("-", "")}_${secret}` };
}

export function parseApiKey(token: string): ParsedApiKey | null {
  const m = TOKEN.exec(token);
  if (!m) return null;
  const [, prefix, hex, secret] = m as unknown as [string, string, string, string];
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { kind: prefix === "pk" ? "publishable" : "secret", id, secret };
}

/** Only this keyed HMAC of the secret is stored, so a copy of the table is of no use as a credential. */
export function hashSecret(pepper: Uint8Array, secret: string): string {
  return createHmac("sha256", pepper).update(secret).digest("hex");
}

export interface IssueApiKeyInput {
  tenantId: string;
  kind: ApiKeyKind;
  scopes: Scope[];
  name: string;
  allowedOrigins?: string[];
}

/** Inserts a new key through `client` (an operator connection: the API role cannot write keys) and returns the token once. */
export async function issueApiKey(client: pg.ClientBase, pepper: Uint8Array, input: IssueApiKeyInput): Promise<{ id: string; token: string }> {
  const key = generateApiKey(input.kind);
  await client.query(
    `INSERT INTO api_keys (id, tenant_id, kind, scopes, secret_hmac, name, allowed_origins) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [key.id, input.tenantId, input.kind, input.scopes, hashSecret(pepper, key.secret), input.name, input.allowedOrigins ?? []],
  );
  return { id: key.id, token: key.token };
}

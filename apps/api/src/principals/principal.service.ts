import { Inject, Injectable } from "@nestjs/common";
import { createHmac, randomUUID } from "node:crypto";
import type pg from "pg";
import { KEY_PROVIDER, type KeyProvider } from "../keys/key-provider.js";

/** People as the API knows them: a pseudonym derived from their identifier, never the identifier itself. */
@Injectable()
export class PrincipalService {
  constructor(@Inject(KEY_PROVIDER) private readonly keys: KeyProvider) {}

  /** Keyed HMAC of the person's identifier and the tenant (decision D12). Tenant-scoped, so tenants cannot link people. */
  pseudonym(identifier: string, tenantId: string): string {
    return createHmac("sha256", this.keys.pseudonymKey()).update(JSON.stringify(["saral.principal", identifier, tenantId])).digest("hex");
  }

  /** The person's id in this tenant, created if this is the first time. Runs inside the caller's transaction. */
  async findOrCreate(c: pg.PoolClient, tenantId: string, pseudonym: string): Promise<string> {
    const existing = await c.query<{ id: string }>("SELECT id FROM tenant_principals WHERE pseudonym_hmac = $1", [pseudonym]);
    if (existing.rows[0]) return existing.rows[0].id;
    const id = randomUUID();
    await c.query("INSERT INTO tenant_principals (tenant_id, id, pseudonym_hmac) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, pseudonym_hmac) DO NOTHING", [tenantId, id, pseudonym]);
    return (await c.query<{ id: string }>("SELECT id FROM tenant_principals WHERE pseudonym_hmac = $1", [pseudonym])).rows[0]?.id as string;
  }
}

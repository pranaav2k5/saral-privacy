import { Inject, Injectable, ServiceUnavailableException, type OnModuleDestroy } from "@nestjs/common";
import pg from "pg";
import { SETTINGS, type Settings } from "../settings.js";

/** What the current transaction is allowed to see. Each value becomes a transaction-local setting read by row-level security. */
export interface AppScope {
  tenantId?: string;
  apiKeyId?: string;
  publicNoticeId?: string;
}

/**
 * The only way the API talks to PostgreSQL. Every call is one transaction that switches to the application role
 * (so row-level security applies) and sets the scope. The pool is created on first use.
 */
@Injectable()
export class Database implements OnModuleDestroy {
  private pool: pg.Pool | undefined;

  constructor(@Inject(SETTINGS) private readonly settings: Settings) {}

  private getPool(): pg.Pool {
    if (this.settings.databaseUrl === undefined) throw new ServiceUnavailableException("the database is not configured");
    this.pool ??= new pg.Pool({ connectionString: this.settings.databaseUrl, max: 10 });
    return this.pool;
  }

  async inScope<T>(scope: AppScope, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE saral_app");
      if (scope.tenantId !== undefined) await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      if (scope.apiKeyId !== undefined) await client.query("SELECT set_config('app.api_key_id', $1, true)", [scope.apiKeyId]);
      if (scope.publicNoticeId !== undefined) await client.query("SELECT set_config('app.public_notice_id', $1, true)", [scope.publicNoticeId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Runs `fn` as the delivery worker role, which sees due webhook deliveries of every tenant and nothing else. */
  async asWorker<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE saral_worker");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}

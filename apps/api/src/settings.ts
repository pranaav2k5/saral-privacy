/** Runtime settings read from the environment once, at startup. Missing values fail when used, not at import. */
export interface Settings {
  databaseUrl: string | undefined;
  nodeEnv: string | undefined;
  devMasterSecret: string | undefined;
  /** Public https base URL of this API. Receipts point to `<base>/v1/notices/<id>`. */
  publicBaseUrl?: string | undefined;
}

export const SETTINGS = Symbol("SETTINGS");

export function readSettings(env: NodeJS.ProcessEnv): Settings {
  return {
    databaseUrl: env.DATABASE_URL || undefined,
    nodeEnv: env.NODE_ENV || undefined,
    devMasterSecret: env.SARAL_DEV_MASTER_SECRET || undefined,
    publicBaseUrl: env.PUBLIC_BASE_URL || undefined,
  };
}

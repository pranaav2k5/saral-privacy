export interface AppConfig {
  port: number;
}

const DEFAULT_PORT = 4000;

/** Reads runtime config from the environment and fails fast on invalid values. */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const raw = env.PORT;
  if (raw === undefined) {
    return { port: DEFAULT_PORT };
  }
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${raw}": must be an integer from 1 to 65535`);
  }
  return { port };
}

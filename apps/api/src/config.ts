export interface AppConfig {
  port: number;
  /** How many proxies sit in front of the app and are believed about the caller's address. Absent when there are none. */
  trustProxy?: number;
}

const DEFAULT_PORT = 4000;

/** Reads runtime config from the environment and fails fast on invalid values. */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  return { port: readPort(env.PORT), ...readTrustProxy(env.TRUST_PROXY) };
}

function readPort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${raw}": must be an integer from 1 to 65535`);
  }
  return port;
}

/**
 * Behind a load balancer every caller has the balancer's address unless the app is told to read the one it forwards. Believing
 * the header with no proxy lets anyone claim any address, so the number of proxies must be stated, not guessed.
 */
function readTrustProxy(raw: string | undefined): { trustProxy?: number } {
  if (raw === undefined) return {};
  const hops = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(hops) || hops > 10) throw new Error(`Invalid TRUST_PROXY "${raw}": must be the number of proxies in front of the app, from 0 to 10`);
  return hops === 0 ? {} : { trustProxy: hops };
}

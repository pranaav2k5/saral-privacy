import { randomUUID } from "node:crypto";
import pg from "pg";
import { createDevKeyProvider } from "../keys/key-provider.js";
import { OperatorError, createStaff, createTenant, disableStaff, enableStaff, issueKey, listKeys, resetStaff, revokeKey, setProfile } from "./operator.js";

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const CHANGE_PASSWORD = "They must choose their own password before they can use the dashboard.";

const USAGE = `Usage:
  operator tenant:create  --name <name> --slug <short-name>
  operator staff:create   --tenant <short-name> --email <email> --role <tenant_admin|dpo>
  operator staff:reset    --tenant <short-name> --email <email>
  operator staff:disable  --tenant <short-name> --email <email>
  operator staff:enable   --tenant <short-name> --email <email>
  operator profile:set    --tenant <short-name> --file <profile.json>
  operator key:issue      --tenant <short-name> --kind <publishable|secret> --name <label> [--scopes <list>] [--origins <list>]
  operator key:list       --tenant <short-name>
  operator key:revoke     --tenant <short-name> --id <key-id>

Environment:
  DATABASE_URL             a role that bypasses row-level security (the database owner)
  SARAL_DEV_MASTER_SECRET  the same value the API runs with, or the accounts could never sign in`;

/** Every flag a command takes, and the ones that may be left out. */
const FLAGS: Record<string, { all: readonly string[]; optional?: readonly string[] }> = {
  "tenant:create": { all: ["name", "slug"] },
  "staff:create": { all: ["tenant", "email", "role"] },
  "staff:reset": { all: ["tenant", "email"] },
  "staff:disable": { all: ["tenant", "email"] },
  "staff:enable": { all: ["tenant", "email"] },
  "profile:set": { all: ["tenant", "file"] },
  "key:issue": { all: ["tenant", "kind", "name", "scopes", "origins"], optional: ["scopes", "origins"] },
  "key:list": { all: ["tenant"] },
  "key:revoke": { all: ["tenant", "id"] },
};

function parse(argv: readonly string[]): { command: string; flags: Record<string, string> } | null {
  const command = argv[0];
  const spec = command === undefined ? undefined : FLAGS[command];
  if (command === undefined || spec === undefined) return null;
  const wanted = spec.all;
  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || !flag.startsWith("--") || value === undefined) return null;
    const name = flag.slice(2);
    if (!wanted.includes(name) || name in flags) return null;
    flags[name] = value;
  }
  return wanted.every((w) => w in flags || spec.optional?.includes(w) === true) ? { command, flags } : null;
}

/**
 * Operator commands for the things the API cannot do: making organisations and staff accounts, and recovering accounts.
 * Passwords are generated and printed once, never typed on the command line. Actions here are made with database
 * credentials and are not written to the organisation's audit log. Returns the exit code: 0 done, 1 failed, 2 bad usage.
 */
export async function runOperator(argv: readonly string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const parsed = parse(argv);
  if (!parsed) {
    io.err(USAGE);
    return 2;
  }
  const { command, flags } = parsed;
  const f = (name: string): string => flags[name] as string;
  if (!env.DATABASE_URL) {
    io.err("DATABASE_URL is required.");
    return 1;
  }
  if (env.NODE_ENV === "production") {
    io.err("The operator tool needs a key provider, and only the development one exists. It refuses to run in production.");
    return 1;
  }
  if (!env.SARAL_DEV_MASTER_SECRET) {
    io.err("SARAL_DEV_MASTER_SECRET is required: it must be the same value the API runs with, or the accounts made here could never sign in.");
    return 1;
  }

  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  try {
    const keys = await createDevKeyProvider(env.SARAL_DEV_MASTER_SECRET, env.NODE_ENV);
    await client.connect();
    switch (command) {
      case "tenant:create": {
        const id = randomUUID();
        await createTenant(client, { name: f("name"), slug: f("slug"), id });
        io.out(`Created the organisation "${f("slug")}" (${f("name")}). Id: ${id}`);
        break;
      }
      case "staff:create": {
        const made = await createStaff(client, keys, { slug: f("tenant"), email: f("email"), role: f("role") });
        io.out(`Created a ${f("role")} account for ${made.email} in "${f("tenant")}". Id: ${made.id}`);
        io.out(`Initial password (shown once): ${made.password}`);
        io.out("They set up an authenticator app when they first sign in.");
        io.out(CHANGE_PASSWORD);
        break;
      }
      case "staff:reset": {
        const done = await resetStaff(client, keys, { slug: f("tenant"), email: f("email") });
        io.out(`Reset the account for ${done.email} in "${f("tenant")}". Their sessions have ended and they set up an authenticator again.`);
        io.out(`Initial password (shown once): ${done.password}`);
        io.out(CHANGE_PASSWORD);
        break;
      }
      case "staff:disable":
        io.out(`Disabled the account for ${await disableStaff(client, keys, { slug: f("tenant"), email: f("email") })}. Their sessions have ended.`);
        break;
      case "profile:set":
        await setProfile(client, { slug: f("tenant"), file: f("file") });
        io.out(`Saved the receipt profile of "${f("tenant")}".`);
        break;
      case "key:issue": {
        const made = await issueKey(client, keys, { slug: f("tenant"), kind: f("kind"), name: f("name"), scopes: flags.scopes, origins: flags.origins });
        io.out(`Issued a ${f("kind")} key "${f("name")}" for "${f("tenant")}" with scope ${made.scopes.join(", ")}. Id: ${made.id}`);
        io.out(`Key (shown once): ${made.token}`);
        io.out("Store it now: it cannot be shown again. If it is lost, revoke it and issue another.");
        break;
      }
      case "key:list": {
        const all = await listKeys(client, { slug: f("tenant") });
        if (all.length === 0) io.out(`"${f("tenant")}" has no keys.`);
        for (const k of all) {
          io.out(`${k.id}  ${k.kind}  ${k.scopes.join(",")}  ${k.name}  ${k.revokedAt === null ? "active" : `revoked ${k.revokedAt}`}`);
          if (k.origins.length > 0) io.out(`  origins: ${k.origins.join(", ")}`);
        }
        break;
      }
      case "key:revoke":
        io.out((await revokeKey(client, { slug: f("tenant"), id: f("id") })) === "revoked" ? `Revoked the key ${f("id")}. It no longer works.` : `The key ${f("id")} was already revoked.`);
        break;
      default:
        io.out(`Enabled the account for ${await enableStaff(client, keys, { slug: f("tenant"), email: f("email") })}. They can sign in with their existing password.`);
    }
    return 0;
  } catch (e) {
    // Only messages written for the operator are shown. Anything else could carry the connection string.
    if (e instanceof OperatorError) io.err(e.message);
    else io.err(`The command failed (${typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "unexpected error"}).`);
    return 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

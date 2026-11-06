import { runOperator } from "../../src/operator/cli.js";
import { MASTER, startApi, type Api } from "./harness.js";
import { totpAt } from "./totp.js";

let api: Api;
beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.stop();
});

const env = (over: Record<string, string | undefined> = {}) => ({ DATABASE_URL: api.db.url, SARAL_DEV_MASTER_SECRET: MASTER, NODE_ENV: "test", ...over });
async function op(args: string[], e: NodeJS.ProcessEnv = env()) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runOperator(args, e, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const passwordOf = (out: string) => (/Initial password \(shown once\): (\S+)/.exec(out) ?? [])[1] as string;
const rows = (sql: string, params: unknown[] = []) => api.db.owner.query(sql, params).then((r) => r.rows as Record<string, unknown>[]);
const login = (slug: string, email: string, password: string) => api.http().post("/v1/auth/login").send({ tenant: slug, email, password });

let n = 0;
const slug = () => `op-test-${String(n++)}`;
const email = () => `op${String(n++)}@example.org`;

async function tenantWithStaff(role = "dpo") {
  const s = slug();
  expect((await op(["tenant:create", "--name", "Operator Test Pvt Ltd", "--slug", s])).code).toBe(0);
  const e = email();
  const made = await op(["staff:create", "--tenant", s, "--email", e, "--role", role]);
  expect(made.code).toBe(0);
  return { slug: s, email: e, password: passwordOf(made.out) };
}
async function firstSignIn(who: { slug: string; email: string; password: string }) {
  const l = await login(who.slug, who.email, who.password);
  const en = await api.http().post("/v1/auth/mfa/enroll").send({ challenge: l.body.challenge });
  const v = await api.http().post("/v1/auth/mfa/verify").send({ challenge: l.body.challenge, code: totpAt(en.body.secret, Date.now()) });
  return { login: l, verify: v, token: v.body.token as string };
}

describe("tenant:create", () => {
  test("makes an organisation and says its id", async () => {
    const s = slug();
    const r = await op(["tenant:create", "--name", "Acme Pvt Ltd", "--slug", s]);
    expect(r.code).toBe(0);
    const row = (await rows("SELECT id, name FROM tenants WHERE slug = $1", [s]))[0];
    expect(row?.name).toBe("Acme Pvt Ltd");
    expect(r.out).toContain(String(row?.id));
  });

  test("refuses a slug that is already taken, in words and with no stack trace", async () => {
    const s = slug();
    await op(["tenant:create", "--name", "One", "--slug", s]);
    const r = await op(["tenant:create", "--name", "Two", "--slug", s]);
    expect(r.code).toBe(1);
    expect(r.err).toBe(`An organisation with the short name "${s}" already exists.`);
  });

  test.each([["Upper-Case"], ["has space"], ["-leading"], [""]])("refuses the short name %j", async (bad) => {
    const r = await op(["tenant:create", "--name", "X", "--slug", bad]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/short name/i);
  });
});

describe("staff:create", () => {
  test("makes an account that can sign in with the printed password and finish authenticator set-up", async () => {
    const who = await tenantWithStaff("dpo");
    expect(who.password.length).toBeGreaterThanOrEqual(24);
    const s = await firstSignIn(who);
    expect(s.login.status).toBe(200);
    expect(s.login.body.mfa).toBe("enroll");
    expect(s.verify.status).toBe(200);
    expect(s.verify.body.role).toBe("dpo");
  });

  test("can make an administrator", async () => {
    const who = await tenantWithStaff("tenant_admin");
    expect((await firstSignIn(who)).verify.body.role).toBe("tenant_admin");
  });

  test("the password is printed once and is stored nowhere in the clear", async () => {
    const who = await tenantWithStaff();
    const all = await rows("SELECT row_to_json(s)::text AS t FROM staff_users s");
    expect(all.some((r) => String(r.t).includes(who.password))).toBe(false);
  });

  test("an unknown organisation, a bad role, a bad email and a duplicate each fail in words and print no password", async () => {
    const who = await tenantWithStaff();
    const cases: [string[], RegExp][] = [
      [["staff:create", "--tenant", "no-such-org", "--email", email(), "--role", "dpo"], /no organisation with the short name "no-such-org"/i],
      [["staff:create", "--tenant", who.slug, "--email", email(), "--role", "root"], /role must be one of: tenant_admin, dpo/],
      [["staff:create", "--tenant", who.slug, "--email", "not-an-email", "--role", "dpo"], /email must be an email address/],
      [["staff:create", "--tenant", who.slug, "--email", who.email.toUpperCase(), "--role", "dpo"], /already has an account/],
    ];
    for (const [args, message] of cases) {
      const r = await op(args);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(message);
      expect(r.out).not.toMatch(/password/i);
    }
  });
});

describe("staff:reset", () => {
  test("gives a new password, ends old sessions, clears the lock and the authenticator, so the person sets up again", async () => {
    const who = await tenantWithStaff();
    const first = await firstSignIn(who);
    expect((await api.http().get("/v1/auth/me").set("Authorization", `Bearer ${first.token}`)).status).toBe(200);
    await rows("UPDATE staff_users SET failed_attempts = 5, locked_until = now() + interval '15 minutes' WHERE tenant_id = (SELECT id FROM tenants WHERE slug = $1)", [who.slug]);

    const versionOf = async () => (await rows("SELECT session_version AS v FROM staff_users WHERE tenant_id = (SELECT id FROM tenants WHERE slug = $1)", [who.slug]))[0]?.v as number;
    const versionBefore = await versionOf();

    const r = await op(["staff:reset", "--tenant", who.slug, "--email", who.email]);
    expect(r.code).toBe(0);
    const fresh = passwordOf(r.out);
    expect(fresh).not.toBe(who.password);

    expect(await versionOf()).toBe(versionBefore + 1); // every session ends, not only those that need the authenticator
    expect((await api.http().get("/v1/auth/me").set("Authorization", `Bearer ${first.token}`)).status).toBe(401);
    expect((await login(who.slug, who.email, who.password)).status).toBe(401);
    const again = await login(who.slug, who.email, fresh);
    expect(again.status).toBe(200);
    expect(again.body.mfa).toBe("enroll");
    const left = await rows("SELECT count(*)::int AS n FROM staff_recovery_codes WHERE tenant_id = (SELECT id FROM tenants WHERE slug = $1)", [who.slug]);
    expect(left[0]?.n).toBe(0);
  });

  test("says so when there is no such person, and does not touch anyone else", async () => {
    const who = await tenantWithStaff();
    const r = await op(["staff:reset", "--tenant", who.slug, "--email", "nobody@example.org"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no account for nobody@example.org/i);
    expect((await login(who.slug, who.email, who.password)).status).toBe(200);
  });

  test("works for the right organisation only: the same address in another organisation is left alone", async () => {
    const a = await tenantWithStaff();
    const otherSlug = slug();
    await op(["tenant:create", "--name", "Other", "--slug", otherSlug]);
    const other = await op(["staff:create", "--tenant", otherSlug, "--email", a.email, "--role", "dpo"]);
    await op(["staff:reset", "--tenant", a.slug, "--email", a.email]);
    expect((await login(otherSlug, a.email, passwordOf(other.out))).status).toBe(200);
  });
});

describe("staff:disable and staff:enable", () => {
  test("disabling ends the sessions and blocks sign-in; enabling allows sign-in again with the same password", async () => {
    const who = await tenantWithStaff();
    const first = await firstSignIn(who);
    expect((await op(["staff:disable", "--tenant", who.slug, "--email", who.email])).code).toBe(0);
    expect((await api.http().get("/v1/auth/me").set("Authorization", `Bearer ${first.token}`)).status).toBe(401);
    expect((await login(who.slug, who.email, who.password)).status).toBe(401);
    expect((await op(["staff:enable", "--tenant", who.slug, "--email", who.email])).code).toBe(0);
    expect((await login(who.slug, who.email, who.password)).status).toBe(200);
  });

  test("disabling twice keeps the time of the first disabling", async () => {
    const who = await tenantWithStaff();
    const at = async () => String((await rows("SELECT disabled_at::text AS disabled_at FROM staff_users WHERE tenant_id = (SELECT id FROM tenants WHERE slug = $1)", [who.slug]))[0]?.disabled_at);
    await op(["staff:disable", "--tenant", who.slug, "--email", who.email]);
    const first = await at();
    await new Promise((r) => setTimeout(r, 20));
    await op(["staff:disable", "--tenant", who.slug, "--email", who.email]);
    expect(await at()).toBe(first);
  });

  test("a disabled account cannot be reset into use", async () => {
    const who = await tenantWithStaff();
    await op(["staff:disable", "--tenant", who.slug, "--email", who.email]);
    const r = await op(["staff:reset", "--tenant", who.slug, "--email", who.email]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/disabled/i);
  });
});

describe("running it safely", () => {
  test("without the development master secret it stops, because accounts made with random keys could never sign in", async () => {
    const r = await op(["tenant:create", "--name", "X", "--slug", slug()], env({ SARAL_DEV_MASTER_SECRET: undefined }));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/SARAL_DEV_MASTER_SECRET is required/);
  });

  test("in production it stops, because only the development key provider exists", async () => {
    const r = await op(["tenant:create", "--name", "X", "--slug", slug()], env({ NODE_ENV: "production" }));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/production/i);
  });

  test("without a database URL it stops", async () => {
    const r = await op(["tenant:create", "--name", "X", "--slug", slug()], env({ DATABASE_URL: undefined }));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/DATABASE_URL is required/);
  });

  test.each([
    [[]],
    [["nonsense"]],
    [["staff:create", "--tenant", "x"]],
    [["tenant:create", "--name", "X", "--slug", "y", "--extra", "z"]],
    [["tenant:create", "--name", "X", "--name", "Y", "--slug", "y"]],
  ])("bad arguments %j print the usage and change nothing", async (args) => {
    const before = await rows("SELECT count(*)::int AS n FROM tenants");
    const r = await op(args);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Usage:/);
    expect((await rows("SELECT count(*)::int AS n FROM tenants"))[0]?.n).toBe(before[0]?.n);
  });

  test("an unexpected database error shows only its code, never its text, which could hold secrets", async () => {
    await api.db.owner.query(`CREATE FUNCTION op_test_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'hunter2secret'; END $$`);
    await api.db.owner.query("CREATE TRIGGER op_test_boom BEFORE INSERT ON tenants FOR EACH ROW EXECUTE FUNCTION op_test_boom()");
    try {
      const r = await op(["tenant:create", "--name", "X", "--slug", slug()]);
      expect(r.code).toBe(1);
      expect(r.err).toBe("The command failed (P0001).");
    } finally {
      await api.db.owner.query("DROP TRIGGER op_test_boom ON tenants");
      await api.db.owner.query("DROP FUNCTION op_test_boom()");
    }
  });

  test("the database URL (which holds a password) is never printed, even on a connection failure", async () => {
    const r = await op(["tenant:create", "--name", "X", "--slug", slug()], env({ DATABASE_URL: "postgres://user:hunter2secret@127.0.0.1:1/none" }));
    expect(r.code).toBe(1);
    expect(r.err).not.toContain("hunter2secret");
  });
});

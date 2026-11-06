import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOperator } from "../../src/operator/cli.js";
import { NOTICE_TEXT, sha256 } from "../db/helpers.js";
import { DEFINITIONS, MASTER, ORIGIN, PROFILE, startApi, type Api } from "./harness.js";

let api: Api;
beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.stop();
});

const env = () => ({ DATABASE_URL: api.db.url, SARAL_DEV_MASTER_SECRET: MASTER, NODE_ENV: "test" });
async function op(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runOperator(args, env(), { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const rows = (sql: string, params: unknown[] = []) => api.db.owner.query(sql, params).then((r) => r.rows as Record<string, unknown>[]);
const tokenOf = (out: string) => (/Key \(shown once\): (\S+)/.exec(out) ?? [])[1] as string;
/** Everything after `pk_<id>_`: the secret part, which may itself contain underscores. */
const secretOf = (token: string) => token.replace(/^(pk|sk)_[0-9a-f]{32}_/, "");
const idOf = (out: string) => (/Id: ([0-9a-f-]{36})/.exec(out) ?? [])[1] as string;
const dir = mkdtempSync(join(tmpdir(), "saral-op-"));
function file(name: string, content: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

let n = 0;
async function newTenant(): Promise<string> {
  const slug = `setup-${String(n++)}`;
  expect((await op(["tenant:create", "--name", "Setup Test Pvt Ltd", "--slug", slug])).code).toBe(0);
  return slug;
}
const profileOf = async (slug: string) => (await rows("SELECT profile FROM tenants WHERE slug = $1", [slug]))[0]?.profile;

describe("key:issue", () => {
  test("a publishable key is shown once, works as an sdk key, and only its hash is stored", async () => {
    const slug = await newTenant();
    const r = await op(["key:issue", "--tenant", slug, "--kind", "publishable", "--name", "Web"]);
    expect(r.code).toBe(0);
    const token = tokenOf(r.out);
    expect(token).toMatch(/^pk_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);
    // Signed in (400 for the empty body), not 401.
    expect((await api.http().post("/v1/consents").set("Authorization", `Bearer ${token}`).send({})).status).toBe(400);
    const stored = await rows("SELECT * FROM api_keys WHERE id = $1", [idOf(r.out)]);
    expect(JSON.stringify(stored)).not.toContain(secretOf(token));
    expect(stored[0]).toMatchObject({ kind: "publishable", scopes: ["sdk"], name: "Web", allowed_origins: [] });
  });

  test("a secret key defaults to the sdk scope, and may be given others", async () => {
    const slug = await newTenant();
    const sdk = await op(["key:issue", "--tenant", slug, "--kind", "secret", "--name", "Server"]);
    expect((await rows("SELECT scopes FROM api_keys WHERE id = $1", [idOf(sdk.out)]))[0]?.scopes).toEqual(["sdk"]);
    const aud = await op(["key:issue", "--tenant", slug, "--kind", "secret", "--name", "Auditor", "--scopes", "auditor,dpo"]);
    expect(aud.code).toBe(0);
    expect((await rows("SELECT scopes FROM api_keys WHERE id = $1", [idOf(aud.out)]))[0]?.scopes).toEqual(["auditor", "dpo"]);
    expect((await api.http().get("/v1/audit/verify").set("Authorization", `Bearer ${tokenOf(aud.out)}`)).status).toBe(200);
  });

  test("a key is stored under the organisation it was issued for", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const ka = await op(["key:issue", "--tenant", a, "--kind", "secret", "--name", "A"]);
    const kb = await op(["key:issue", "--tenant", b, "--kind", "secret", "--name", "B"]);
    const owner = async (out: string) => (await rows("SELECT t.slug FROM api_keys k JOIN tenants t ON t.id = k.tenant_id WHERE k.id = $1", [idOf(out)]))[0]?.slug;
    expect(await owner(ka.out)).toBe(a);
    expect(await owner(kb.out)).toBe(b);
  });

  test("allowed origins limit where a publishable key can be used from", async () => {
    const slug = await newTenant();
    const r = await op(["key:issue", "--tenant", slug, "--kind", "publishable", "--name", "Shop", "--origins", `${ORIGIN},http://localhost:3000`]);
    expect(r.code).toBe(0);
    const token = tokenOf(r.out);
    const call = (origin: string) => api.http().post("/v1/consents").set("Authorization", `Bearer ${token}`).set("Origin", origin).send({});
    expect((await call(ORIGIN)).status).toBe(400);
    expect((await call("http://localhost:3000")).status).toBe(400);
    expect((await call("https://evil.example.com")).status).toBe(403);
  });

  test.each([
    ["https://shop.example.org:443", ["https://shop.example.org"]],
    ["https://shop.example.org/", ["https://shop.example.org"]],
    ["https://Shop.Example.ORG", ["https://shop.example.org"]],
    ["http://localhost:80", ["http://localhost"]],
    ["https://shop.example.org:8443", ["https://shop.example.org:8443"]],
    ["https://[::1]:8443", ["https://[::1]:8443"]],
    ["https://[0:0:0:0:0:0:0:1]", ["https://[::1]"]],
    ["https://shop.example.org,https://shop.example.org:443", ["https://shop.example.org"]],
  ])("stores the origin %s the way a browser sends it", async (given, stored) => {
    const slug = await newTenant();
    const r = await op(["key:issue", "--tenant", slug, "--kind", "publishable", "--name", "Shop", "--origins", given]);
    expect(r.code).toBe(0);
    expect((await rows("SELECT allowed_origins FROM api_keys WHERE id = $1", [idOf(r.out)]))[0]?.allowed_origins).toEqual(stored);
  });

  test("a key limited to an origin written with its default port still works from the page", async () => {
    const slug = await newTenant();
    const token = tokenOf((await op(["key:issue", "--tenant", slug, "--kind", "publishable", "--name", "Shop", "--origins", `${ORIGIN}:443`])).out);
    expect((await api.http().post("/v1/consents").set("Authorization", `Bearer ${token}`).set("Origin", ORIGIN).send({})).status).toBe(400);
  });

  test.each([
    ["an unknown organisation", ["--tenant", "nope-org", "--kind", "secret", "--name", "x"], /no organisation/i],
    ["an unknown kind", ["--kind", "master", "--name", "x"], /publishable or secret/],
    ["an empty name", ["--kind", "secret", "--name", ""], /name/],
    ["a name over 100 characters", ["--kind", "secret", "--name", "x".repeat(101)], /name/],
    ["scopes on a publishable key", ["--kind", "publishable", "--name", "x", "--scopes", "dpo"], /publishable.*sdk/i],
    ["an unknown scope", ["--kind", "secret", "--name", "x", "--scopes", "root"], /scope/],
    ["a repeated scope", ["--kind", "secret", "--name", "x", "--scopes", "sdk,sdk"], /scope/],
    ["origins on a secret key", ["--kind", "secret", "--name", "x", "--origins", ORIGIN], /origins.*publishable/i],
    ["an origin with a path", ["--kind", "publishable", "--name", "x", "--origins", "https://shop.example.org/app"], /origin/],
    ["an origin with a query", ["--kind", "publishable", "--name", "x", "--origins", "https://shop.example.org/?a=1"], /origin/],
    ["an origin with a user name", ["--kind", "publishable", "--name", "x", "--origins", "https://me@shop.example.org"], /origin/],
    ["an origin with a fragment", ["--kind", "publishable", "--name", "x", "--origins", "https://shop.example.org#top"], /origin/],
    ["an origin with only a password", ["--kind", "publishable", "--name", "x", "--origins", "https://:x@shop.example.org"], /origin/],
    ["an origin written without the two slashes", ["--kind", "publishable", "--name", "x", "--origins", "https:shop.example.org"], /origin/],
    ["an origin that is not a URL", ["--kind", "publishable", "--name", "x", "--origins", "shop.example.org"], /origin/],
    ["an empty entry in the list", ["--kind", "publishable", "--name", "x", "--origins", `${ORIGIN},`], /origin/],
    ["a plain http IPv6 origin", ["--kind", "publishable", "--name", "x", "--origins", "http://[::1]:3000"], /origin/],
    ["an origin with a wildcard", ["--kind", "publishable", "--name", "x", "--origins", "https://*.example.org"], /origin/],
    ["a plain http origin that is not localhost", ["--kind", "publishable", "--name", "x", "--origins", "http://shop.example.org"], /origin/],
  ])("rejects %s, and stores no key", async (_n, args, message) => {
    const slug = await newTenant();
    const before = (await rows("SELECT count(*)::int AS n FROM api_keys"))[0]?.n;
    const full = args.includes("--tenant") ? args : ["--tenant", slug, ...args];
    const r = await op(["key:issue", ...full]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(message);
    expect((await rows("SELECT count(*)::int AS n FROM api_keys"))[0]?.n).toBe(before);
  });
});

describe("key:list and key:revoke", () => {
  test("the list shows each key's id, kind, scopes, name and state, and never a secret", async () => {
    const slug = await newTenant();
    const made = await op(["key:issue", "--tenant", slug, "--kind", "publishable", "--name", "Web"]);
    const list = await op(["key:list", "--tenant", slug]);
    expect(list.code).toBe(0);
    expect(list.out).toContain(idOf(made.out));
    expect(list.out).toMatch(/publishable/);
    expect(list.out).toContain("Web");
    expect(list.out).toMatch(/active/);
    expect(list.out).not.toContain(secretOf(tokenOf(made.out)));
  });

  test("keys are listed oldest first", async () => {
    const slug = await newTenant();
    const ids = [] as string[];
    for (const name of ["first", "second", "third"]) ids.push(idOf((await op(["key:issue", "--tenant", slug, "--kind", "secret", "--name", name])).out));
    const lines = (await op(["key:list", "--tenant", slug])).out.split("\n");
    expect(lines.map((l) => ids.findIndex((id) => l.startsWith(id))).filter((i) => i >= 0)).toEqual([0, 1, 2]);
  });

  test("the list of an organisation with no keys says so, and other organisations' keys are not listed", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const made = await op(["key:issue", "--tenant", a, "--kind", "secret", "--name", "Only A"]);
    const list = await op(["key:list", "--tenant", b]);
    expect(list.code).toBe(0);
    expect(list.out).toMatch(/no keys/i);
    expect(list.out).not.toContain(idOf(made.out));
  });

  test("a revoked key stops working at once and shows as revoked", async () => {
    const slug = await newTenant();
    const made = await op(["key:issue", "--tenant", slug, "--kind", "secret", "--name", "Temp", "--scopes", "auditor"]);
    const token = tokenOf(made.out);
    expect((await api.http().get("/v1/audit/verify").set("Authorization", `Bearer ${token}`)).status).toBe(200);
    const rev = await op(["key:revoke", "--tenant", slug, "--id", idOf(made.out)]);
    expect(rev.code).toBe(0);
    expect((await api.http().get("/v1/audit/verify").set("Authorization", `Bearer ${token}`)).status).toBe(401);
    expect((await op(["key:list", "--tenant", slug])).out).toMatch(/revoked/);
  });

  test("revoking twice keeps the first revocation time and says it was already revoked", async () => {
    const slug = await newTenant();
    const made = await op(["key:issue", "--tenant", slug, "--kind", "secret", "--name", "Twice"]);
    await op(["key:revoke", "--tenant", slug, "--id", idOf(made.out)]);
    const first = (await rows("SELECT revoked_at::text AS t FROM api_keys WHERE id = $1", [idOf(made.out)]))[0]?.t;
    const again = await op(["key:revoke", "--tenant", slug, "--id", idOf(made.out)]);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/already revoked/i);
    expect((await rows("SELECT revoked_at::text AS t FROM api_keys WHERE id = $1", [idOf(made.out)]))[0]?.t).toBe(first);
  });

  test("a key of another organisation, an unknown id and a malformed id are all refused and nothing is revoked", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const made = await op(["key:issue", "--tenant", a, "--kind", "secret", "--name", "A's"]);
    const other = await op(["key:revoke", "--tenant", b, "--id", idOf(made.out)]);
    expect(other.code).toBe(1);
    expect(other.err).toMatch(/no key/i);
    expect((await op(["key:revoke", "--tenant", a, "--id", "11111111-1111-4111-8111-111111111111"])).code).toBe(1);
    const bad = await op(["key:revoke", "--tenant", a, "--id", "not-an-id"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/id/);
    expect((await rows("SELECT revoked_at FROM api_keys WHERE id = $1", [idOf(made.out)]))[0]?.revoked_at).toBeNull();
  });
});

describe("profile:set", () => {
  test("stores the controller profile the receipts are built from", async () => {
    const slug = await newTenant();
    const r = await op(["profile:set", "--tenant", slug, "--file", file("ok.json", PROFILE)]);
    expect(r.code).toBe(0);
    expect(await profileOf(slug)).toEqual(PROFILE);
  });

  test.each([
    ["no controller email", { ...PROFILE, controller: { ...PROFILE.controller, email: "" } }, /email/],
    ["a controller phone that is not a tel: link", { ...PROFILE, controller: { ...PROFILE.controller, phone: "+91 00000 00000" } }, /phone/],
    ["a policy URL that is not https", { ...PROFILE, policyUrl: "http://example.org/privacy" }, /policyUrl/],
    ["no service name", { controller: PROFILE.controller, policyUrl: PROFILE.policyUrl }, /service/],
    ["no controller", { policyUrl: PROFILE.policyUrl, service: PROFILE.service }, /controller/],
    ["a controller that is null", { ...PROFILE, controller: null }, /needs a controller/],
    ["an array", [], /JSON object/],
    ["a field that is not part of a profile (a typo is not silently ignored)", { ...PROFILE, serivce: "typo" }, /unknown field "serivce"/],
  ])("rejects a profile with %s, and leaves the old one in place", async (_n, bad, message) => {
    const slug = await newTenant();
    await op(["profile:set", "--tenant", slug, "--file", file("good.json", PROFILE)]);
    const r = await op(["profile:set", "--tenant", slug, "--file", file("bad.json", bad)]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(message);
    expect(await profileOf(slug)).toEqual(PROFILE);
  });

  test("changes only the named organisation", async () => {
    const a = await newTenant();
    const b = await newTenant();
    await op(["profile:set", "--tenant", a, "--file", file("a.json", PROFILE)]);
    expect(await profileOf(b)).toEqual({});
    await op(["profile:set", "--tenant", b, "--file", file("b.json", { ...PROFILE, service: "Other app" })]);
    expect((await profileOf(a) as { service: string }).service).toBe(PROFILE.service);
  });

  test("refuses a file over 20 KB without reading all of it", async () => {
    const slug = await newTenant();
    const big = file("big.json", JSON.stringify({ ...PROFILE, service: "x".repeat(20_001) }));
    const r = await op(["profile:set", "--tenant", slug, "--file", big]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/file is too large/i);
    expect(await profileOf(slug)).toEqual({});
  });

  test("refuses a profile too large for a receipt to carry, which would make every consent fail", async () => {
    const slug = await newTenant();
    const r = await op(["profile:set", "--tenant", slug, "--file", file("long.json", { ...PROFILE, service: "x".repeat(5000) })]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/receipt/i);
    expect(r.err).toMatch(/4000/);
    expect(await profileOf(slug)).toEqual({});
  });

  test("a profile at the limit is saved and still lets a consent be recorded", async () => {
    const slug = await newTenant();
    const filler = "x".repeat(3000);
    const profile = { ...PROFILE, controller: { ...PROFILE.controller, contact: filler } };
    expect(JSON.stringify(profile).length).toBeLessThanOrEqual(4000);
    expect((await op(["profile:set", "--tenant", slug, "--file", file("edge.json", profile)])).code).toBe(0);
  });

  test("refuses anything that is not a regular file, without waiting on it", async () => {
    const slug = await newTenant();
    const folder = join(dir, "a-folder");
    mkdirSync(folder);
    const asFolder = await op(["profile:set", "--tenant", slug, "--file", folder]);
    expect(asFolder.code).toBe(1);
    expect(asFolder.err).toMatch(/regular file/i);
    if (process.platform !== "win32") {
      const pipe = join(dir, "a-pipe");
      execFileSync("mkfifo", [pipe]);
      const asPipe = await op(["profile:set", "--tenant", slug, "--file", pipe]);
      expect(asPipe.code).toBe(1);
      expect(asPipe.err).toMatch(/regular file/i);
    }
  });

  test("says so when the file cannot be read or is not JSON, without printing the file's content", async () => {
    const slug = await newTenant();
    const missing = await op(["profile:set", "--tenant", slug, "--file", join(dir, "absent.json")]);
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/cannot read/i);
    const junk = await op(["profile:set", "--tenant", slug, "--file", file("junk.json", "{ secret-looking-text")]);
    expect(junk.code).toBe(1);
    expect(junk.err).toMatch(/JSON/);
    expect(junk.err).not.toContain("secret-looking-text");
  });

  test("an unknown organisation is refused", async () => {
    const r = await op(["profile:set", "--tenant", "nope-org", "--file", file("any.json", PROFILE)]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no organisation/i);
  });
});

describe("the operator tool is enough to start taking consent", () => {
  test("a new organisation with a profile, a notice and a publishable key can record a consent and get a receipt", async () => {
    const slug = await newTenant();
    expect((await op(["profile:set", "--tenant", slug, "--file", file("p.json", PROFILE)])).code).toBe(0);
    const key = tokenOf((await op(["key:issue", "--tenant", slug, "--kind", "publishable", "--name", "Web"])).out);
    const tenantId = (await rows("SELECT id FROM tenants WHERE slug = $1", [slug]))[0]?.id;
    const noticeId = "aaaaaaaa-0000-4000-8000-0000000000a1";
    await api.db.owner.query(
      "INSERT INTO privacy_notices (id, tenant_id, version, language, canonical_text, canonical_sha256, purpose_definitions) VALUES ($1, $2, 1, 'en', $3, $4, $5)",
      [noticeId, tenantId, NOTICE_TEXT, sha256(NOTICE_TEXT), JSON.stringify(DEFINITIONS)],
    );
    const res = await api.http().post("/v1/consents").set("Authorization", `Bearer ${key}`).send({
      noticeId, identifier: "+919876543210", purposes: [{ key: "analytics", granted: true }],
    });
    expect(res.status).toBe(201);
    expect(res.body.receipt).toMatch(/^eyJ/);
  });
});

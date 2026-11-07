import { signToken, type TokenPayload } from "../../src/staff/session-token.js";
import { createStaffUser } from "../../src/staff/staff-admin.js";
import { startApi, type Api } from "./harness.js";
import { totpAt } from "./totp.js";

let api: Api;
beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.stop();
});

const PASSWORD = "correct horse battery staple";
const NEXT = "a different long passphrase 42";
let n = 0;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const owner = (sql: string, params: unknown[] = []) => api.db.owner.query(sql, params).then((r) => r.rows as Record<string, unknown>[]);

async function makeStaff(role: "dpo" | "tenant_admin" = "dpo", tenant = api.A) {
  const email = `pw${String(n++)}@example.org`;
  const id = await createStaffUser(api.db.owner, api.keys, { tenantId: tenant.id, email, password: PASSWORD, role });
  return { id, email };
}
const login = (email: string, password: string, slug = "tenant-a") => api.http().post("/v1/auth/login").send({ tenant: slug, email, password });

/** A signed-in person: password, authenticator set-up, a first code. */
async function signedIn(role: "dpo" | "tenant_admin" = "dpo") {
  const who = await makeStaff(role);
  const l = await login(who.email, PASSWORD);
  const e = await api.http().post("/v1/auth/mfa/enroll").send({ challenge: l.body.challenge });
  const v = await api.http().post("/v1/auth/mfa/verify").send({ challenge: l.body.challenge, code: totpAt(e.body.secret, Date.now()) });
  return { ...who, secret: e.body.secret as string, token: v.body.token as string, recoveryCodes: v.body.recoveryCodes as string[] };
}
/** The code just used would be refused as a replay; this lets the next sign-in use the current one. */
const allowNextCode = (id: string) => owner("UPDATE staff_users SET last_totp_step = -1 WHERE id = $1", [id]);
const change = (token: string, currentPassword: unknown, newPassword: unknown) => api.http().post("/v1/auth/password").set(bearer(token)).send({ currentPassword, newPassword });
const me = (token: string) => api.http().get("/v1/auth/me").set(bearer(token));
const hashOf = async (id: string) => (await owner("SELECT password_hash FROM staff_users WHERE id = $1", [id]))[0]?.password_hash as string;
const failures = async (id: string) => (await owner("SELECT failed_attempts FROM staff_users WHERE id = $1", [id]))[0]?.failed_attempts as number;
const authTimeOf = (token: string) => (JSON.parse(Buffer.from(token.split(".")[1] as string, "base64url").toString()) as { auth: number }).auth;

describe("changing your own password", () => {
  test("gives a new session that works, and from then on only the new password signs in", async () => {
    const s = await signedIn();
    const before = await hashOf(s.id);
    const res = await change(s.token, PASSWORD, NEXT);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ role: "dpo" });
    expect(res.body.token).toMatch(/^st_v1\./);
    expect(res.body).not.toHaveProperty("recoveryCodes");
    expect(Date.parse(res.body.expiresAt as string) - Date.now()).toBeGreaterThan(14 * 60_000);
    expect((await me(res.body.token as string)).status).toBe(200);
    expect(await hashOf(s.id)).not.toBe(before);

    expect((await login(s.email, PASSWORD)).status).toBe(401);
    const l = await login(s.email, NEXT);
    expect(l.status).toBe(200);
    expect(l.body.mfa).toBe("verify");
    await allowNextCode(s.id);
    const v = await api.http().post("/v1/auth/mfa/verify").send({ challenge: l.body.challenge, code: totpAt(s.secret, Date.now()) });
    expect(v.status).toBe(200);
  });

  test("ends every other session of that person, the one used and any renewed from it, and nobody else's", async () => {
    const s = await signedIn();
    const other = await signedIn();
    const renewed = (await api.http().post("/v1/auth/refresh").set(bearer(s.token))).body.token as string;
    expect((await me(renewed)).status).toBe(200);
    const res = await change(s.token, PASSWORD, NEXT);
    expect((await me(s.token)).status).toBe(401);
    expect((await me(renewed)).status).toBe(401);
    expect((await me(other.token)).status).toBe(200);
    expect((await me(res.body.token as string)).status).toBe(200);
  });

  test("keeps the time of the real sign-in, so the eight-hour limit does not start again", async () => {
    const s = await signedIn();
    // The same session, but as it would be an hour after the person really signed in.
    const now = Math.floor(Date.now() / 1000);
    const payload = JSON.parse(Buffer.from(s.token.split(".")[1] as string, "base64url").toString()) as TokenPayload;
    const hourOld = signToken(api.keys.sessionKey(), { ...payload, auth: now - 3600 });
    const res = await change(hourOld, PASSWORD, NEXT);
    expect(res.status).toBe(200);
    expect(authTimeOf(res.body.token as string)).toBe(now - 3600);
  });

  test("is refused for a session older than eight hours since the real sign-in, as renewing it is, so changing the password cannot be used to keep a session alive for ever", async () => {
    const s = await signedIn();
    const now = Math.floor(Date.now() / 1000);
    const payload = JSON.parse(Buffer.from(s.token.split(".")[1] as string, "base64url").toString()) as TokenPayload;
    const tooOld = signToken(api.keys.sessionKey(), { ...payload, auth: now - 8 * 3600 - 5 });
    const before = await hashOf(s.id);
    expect((await api.http().post("/v1/auth/refresh").set(bearer(tooOld))).status).toBe(401);
    const res = await change(tooOld, PASSWORD, NEXT);
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/reached its limit/);
    expect(await hashOf(s.id)).toBe(before);
    expect(await failures(s.id)).toBe(0);
    // Just inside the limit it still works.
    const almost = signToken(api.keys.sessionKey(), { ...payload, auth: now - 8 * 3600 + 60 });
    expect((await change(almost, PASSWORD, NEXT)).status).toBe(200);
  });

  test("leaves the authenticator and the recovery codes alone", async () => {
    const s = await signedIn();
    await change(s.token, PASSWORD, NEXT);
    const l = await login(s.email, NEXT);
    const v = await api.http().post("/v1/auth/mfa/verify").send({ challenge: l.body.challenge, code: (s.recoveryCodes[0] as string) });
    expect(v.status).toBe(200);
  });

  test("is an audit event under the person's id, the log still verifies, and no password is stored in the clear", async () => {
    const s = await signedIn("tenant_admin");
    await change(s.token, PASSWORD, NEXT);
    const entry = (await owner("SELECT actor_id, ref_table, ref_id FROM consent_audit_log WHERE tenant_id = $1 AND action = 'staff.password_changed' AND ref_id = $2", [api.A.id, s.id]))[0];
    expect(entry).toMatchObject({ actor_id: `staff:${s.id}`, ref_table: "staff_users" });
    expect((await api.http().get("/v1/audit/verify").set(bearer(api.A.auditor))).body.ok).toBe(true);
    const stored = await hashOf(s.id);
    expect(stored).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(stored).not.toContain(NEXT);
    expect(JSON.stringify(await owner("SELECT * FROM consent_audit_log WHERE tenant_id = $1", [api.A.id]))).not.toContain(NEXT);
  });

  test("two attempts at the same moment: one succeeds and the other finds its session already ended", async () => {
    const s = await signedIn();
    const results = await Promise.all([change(s.token, PASSWORD, NEXT), change(s.token, PASSWORD, "yet another long passphrase 7")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });
});

describe("a wrong current password", () => {
  test("is refused as 'not possible as asked' (422), never as a ended session (401), and changes nothing", async () => {
    const s = await signedIn();
    const before = await hashOf(s.id);
    const res = await change(s.token, "not my password at all", NEXT);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "wrong_password", message: "The current password is not right." });
    expect((await me(s.token)).status).toBe(200);
    expect(await hashOf(s.id)).toBe(before);
    expect((await login(s.email, PASSWORD)).status).toBe(200);
    expect(await failures(s.id)).toBe(1);
  });

  test("five in a row lock the account for 15 minutes, as at sign-in: even the right password is then refused, here and at sign-in, and it is audited", async () => {
    const s = await signedIn();
    for (let i = 0; i < 5; i++) expect((await change(s.token, "not my password at all", NEXT)).status).toBe(422);
    const locked = await change(s.token, PASSWORD, NEXT);
    expect(locked.status).toBe(403);
    expect(locked.body).toEqual({ error: "locked", message: "Too many wrong passwords. Try again in 15 minutes." });
    expect((await login(s.email, PASSWORD)).status).toBe(401);
    expect((await owner("SELECT 1 FROM consent_audit_log WHERE tenant_id = $1 AND action = 'staff.locked' AND ref_id = $2", [api.A.id, s.id])).length).toBe(1);
    expect((await me(s.token)).status).toBe(200);
  });

  test("a successful change clears earlier wrong attempts", async () => {
    const s = await signedIn();
    await change(s.token, "not my password at all", NEXT);
    await change(s.token, "not my password at all", NEXT);
    expect(await failures(s.id)).toBe(2);
    expect((await change(s.token, PASSWORD, NEXT)).status).toBe(200);
    expect(await failures(s.id)).toBe(0);
  });
});

describe("the new password", () => {
  const bad: [string, (email: string) => string, string | RegExp][] = [
    ["shorter than 12 characters", () => "too short 1", /at least 12/],
    ["longer than 128 characters", () => "x".repeat(129), /at most 128/],
    ["the person's email address", (e) => e, /email address/],
    ["one character repeated", () => "a".repeat(20), /repeated/],
    ["the same as the current one", () => PASSWORD, /different from the current/],
  ];
  test.each(bad)("is refused when it is %s, and changes nothing and counts as no failure", async (_n, pick, message) => {
    const s = await signedIn();
    const before = await hashOf(s.id);
    const res = await change(s.token, PASSWORD, pick(s.email));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.field).toBe("newPassword");
    expect(res.body.message).toMatch(message);
    expect(await hashOf(s.id)).toBe(before);
    expect(await failures(s.id)).toBe(0);
    expect((await me(s.token)).status).toBe(200);
  });

  test("is judged before the current password, so a weak one with a wrong current password counts no failure", async () => {
    const s = await signedIn();
    const res = await change(s.token, "not my password at all", "too short 1");
    expect(res.status).toBe(400);
    expect(await failures(s.id)).toBe(0);
  });

  test("is not echoed back in any error", async () => {
    const s = await signedIn();
    const weak = "weakweak1";
    expect(JSON.stringify((await change(s.token, PASSWORD, weak)).body)).not.toContain(weak);
    expect(JSON.stringify((await change(s.token, "wrong current pass", NEXT)).body)).not.toContain(NEXT);
  });
});

describe("the request", () => {
  test.each([
    ["a missing current password", undefined, NEXT, "currentPassword"],
    ["an empty current password", "", NEXT, "currentPassword"],
    ["a current password that is not text", 12345, NEXT, "currentPassword"],
    ["a current password over 128 characters", "x".repeat(129), NEXT, "currentPassword"],
    ["a missing new password", PASSWORD, undefined, "newPassword"],
    ["a new password that is not text", PASSWORD, { a: 1 }, "newPassword"],
  ])("is refused with %s", async (_n, current, next, field) => {
    const s = await signedIn();
    const res = await change(s.token, current, next);
    expect(res.status).toBe(400);
    expect(res.body.field).toBe(field);
    expect(await failures(s.id)).toBe(0);
  });

  test("must be a JSON object", async () => {
    const s = await signedIn();
    expect((await api.http().post("/v1/auth/password").set(bearer(s.token)).send([])).status).toBe(400);
  });
});

describe("who may change a password", () => {
  test("only a signed-in person: an API key, even a tenant admin's, and a sign-in challenge are refused", async () => {
    const s = await signedIn();
    expect((await change(api.A.admin, PASSWORD, NEXT)).status).toBe(403);
    expect((await change(api.A.server, PASSWORD, NEXT)).status).toBe(403);
    expect((await change(api.A.pk, PASSWORD, NEXT)).status).toBe(403);
    const challenge = (await login(s.email, PASSWORD)).body.challenge as string;
    expect((await change(challenge, PASSWORD, NEXT)).status).toBe(401);
    expect((await api.http().post("/v1/auth/password").send({ currentPassword: PASSWORD, newPassword: NEXT })).status).toBe(401);
    expect((await login(s.email, PASSWORD)).status).toBe(200);
  });

  test("a person in one organisation changes only their own account", async () => {
    const mine = await signedIn();
    const theirs = await makeStaff("dpo", api.B);
    const before = await hashOf(theirs.id);
    await change(mine.token, PASSWORD, NEXT);
    expect(await hashOf(theirs.id)).toBe(before);
  });

  test("an account that has been disabled cannot change its password with a session from before", async () => {
    const s = await signedIn();
    await owner("UPDATE staff_users SET disabled_at = now() WHERE id = $1", [s.id]);
    expect((await change(s.token, PASSWORD, NEXT)).status).toBe(401);
  });
});

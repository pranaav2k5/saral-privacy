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

/** An account the way the operator tool makes one (the password must be changed) or the way the tests usually do (it need not be). */
async function makeStaff(mustChangePassword: boolean, role: "dpo" | "tenant_admin" = "dpo") {
  const email = `force${String(n++)}@example.org`;
  const id = await createStaffUser(api.db.owner, api.keys, { tenantId: api.A.id, email, password: PASSWORD, role, mustChangePassword });
  return { id, email };
}
const login = (email: string, password: string) => api.http().post("/v1/auth/login").send({ tenant: "tenant-a", email, password });

async function signedIn(mustChangePassword: boolean, role: "dpo" | "tenant_admin" = "dpo") {
  const who = await makeStaff(mustChangePassword, role);
  const l = await login(who.email, PASSWORD);
  const e = await api.http().post("/v1/auth/mfa/enroll").send({ challenge: l.body.challenge });
  const v = await api.http().post("/v1/auth/mfa/verify").send({ challenge: l.body.challenge, code: totpAt(e.body.secret, Date.now()) });
  return { ...who, secret: e.body.secret as string, session: v.body as { token: string; expiresAt: string; role: string; mustChangePassword?: boolean } };
}
const flagOf = async (id: string) => (await owner("SELECT must_change_password FROM staff_users WHERE id = $1", [id]))[0]?.must_change_password as boolean;
const get = (path: string, token: string) => api.http().get(path).set(bearer(token));
const change = (token: string, currentPassword: string, newPassword: string) => api.http().post("/v1/auth/password").set(bearer(token)).send({ currentPassword, newPassword });

describe("an account whose password must be changed", () => {
  test("signs in as usual, and the session says the password must be changed", async () => {
    const s = await signedIn(true);
    expect(s.session).toMatchObject({ role: "dpo", mustChangePassword: true });
    expect(s.session.token).toMatch(/^st_v1\./);
  });

  test("a session of an ordinary account says it need not be", async () => {
    const s = await signedIn(false);
    expect(s.session.mustChangePassword).toBe(false);
  });

  test("can do nothing but see who it is, renew the session and change the password", async () => {
    const s = await signedIn(true);
    for (const path of ["/v1/dsr", "/v1/audit/verify"]) {
      const res = await get(path, s.session.token);
      expect({ path, status: res.status, error: res.body.error }).toEqual({ path, status: 403, error: "password_change_required" });
      expect(res.body.message).toBe("Choose a new password before you do anything else.");
    }
    const post = await api.http().post("/v1/dsr/00000000-0000-4000-8000-000000000000/transition").set(bearer(s.session.token)).send({ to: "in_progress" });
    expect(post.status).toBe(403);
    expect(post.body.error).toBe("password_change_required");

    const who = await get("/v1/auth/me", s.session.token);
    expect(who.status).toBe(200);
    expect(who.body.mustChangePassword).toBe(true);
    const renewed = await api.http().post("/v1/auth/refresh").set(bearer(s.session.token));
    expect(renewed.status).toBe(200);
    expect(renewed.body.mustChangePassword).toBe(true);
    expect((await get("/v1/dsr", renewed.body.token as string)).status).toBe(403);
  });

  test("an administrator is held back in the same way", async () => {
    const s = await signedIn(true, "tenant_admin");
    for (const path of ["/v1/notices", "/v1/webhook-endpoints"]) {
      const res = await get(path, s.session.token);
      expect({ path, status: res.status, error: res.body.error }).toEqual({ path, status: 403, error: "password_change_required" });
    }
  });

  test("a wrong current password does not release it", async () => {
    const s = await signedIn(true);
    const res = await change(s.session.token, "not the password", NEXT);
    expect(res.status).toBe(422);
    expect(await flagOf(s.id)).toBe(true);
    expect((await get("/v1/dsr", s.session.token)).status).toBe(403);
  });

  test("a weak or unchanged new password does not release it", async () => {
    const s = await signedIn(true);
    expect((await change(s.session.token, PASSWORD, "short")).status).toBe(400);
    expect((await change(s.session.token, PASSWORD, PASSWORD)).status).toBe(400);
    expect(await flagOf(s.id)).toBe(true);
  });

  test("changing the password releases it: the new session works everywhere, the old one has ended", async () => {
    const s = await signedIn(true);
    const res = await change(s.session.token, PASSWORD, NEXT);
    expect(res.status).toBe(200);
    expect(res.body.mustChangePassword).toBe(false);
    expect(await flagOf(s.id)).toBe(false);
    expect((await get("/v1/dsr", res.body.token as string)).status).toBe(200);
    expect((await get("/v1/auth/me", res.body.token as string)).body.mustChangePassword).toBe(false);
    expect((await get("/v1/dsr", s.session.token)).status).toBe(401);
    const renewed = await api.http().post("/v1/auth/refresh").set(bearer(res.body.token as string));
    expect(renewed.body.mustChangePassword).toBe(false);
  });

  test("signing in again after the change is a plain sign-in", async () => {
    const s = await signedIn(true);
    await change(s.session.token, PASSWORD, NEXT);
    await owner("UPDATE staff_users SET last_totp_step = -1 WHERE id = $1", [s.id]);
    const l = await login(s.email, NEXT);
    const v = await api.http().post("/v1/auth/mfa/verify").send({ challenge: l.body.challenge, code: totpAt(s.secret, Date.now()) });
    expect(v.body.mustChangePassword).toBe(false);
    expect((await get("/v1/dsr", v.body.token as string)).status).toBe(200);
  });

  test("is not a reason to refuse an API key, which has no password", async () => {
    await makeStaff(true);
    expect((await api.http().get("/v1/dsr").set(bearer(api.A.dpo))).status).toBe(200);
  });
});

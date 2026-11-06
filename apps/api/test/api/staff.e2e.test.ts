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
let n = 0;
const emailOf = () => `staff${String(n++)}@example.org`;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const owner = (sql: string, params: unknown[] = []) => api.db.owner.query(sql, params).then((r) => r.rows as Record<string, unknown>[]);

async function makeStaff(tenant: { id: string }, role: "dpo" | "tenant_admin", email = emailOf(), password = PASSWORD) {
  const id = await createStaffUser(api.db.owner, api.keys, { tenantId: tenant.id, email, password, role });
  return { id, email, password };
}
const login = (slug: string, email: string, password: string) => api.http().post("/v1/auth/login").send({ tenant: slug, email, password });

/** Password, then first-time authenticator set-up, then the first code. Returns everything a test may need. */
async function firstSignIn(slug: string, who: { email: string; password: string }) {
  const l = await login(slug, who.email, who.password);
  const e = await api.http().post("/v1/auth/mfa/enroll").send({ challenge: l.body.challenge });
  const v = await api.http().post("/v1/auth/mfa/verify").send({ challenge: l.body.challenge, code: totpAt(e.body.secret, Date.now()) });
  return { login: l, enroll: e, verify: v, secret: e.body.secret as string, token: v.body.token as string };
}

describe("signing in for the first time", () => {
  test("password, then authenticator set-up, then a code: gives a session and recovery codes shown once", async () => {
    const who = await makeStaff(api.A, "dpo");
    const s = await firstSignIn("tenant-a", who);
    expect(s.login.status).toBe(200);
    expect(s.login.body.mfa).toBe("enroll");
    expect(s.enroll.status).toBe(200);
    expect(s.enroll.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(s.enroll.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Saral%20Privacy:/);
    expect(s.verify.status).toBe(200);
    expect(s.verify.body).toMatchObject({ role: "dpo" });
    expect(s.verify.body.token).toMatch(/^st_v1\./);
    expect(s.verify.body.recoveryCodes).toHaveLength(8);
    for (const c of s.verify.body.recoveryCodes) expect(c).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);
    expect(Date.parse(s.verify.body.expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(Date.parse(s.verify.body.expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
  });

  test("the session works on /v1/auth/me and shows who and what it may do, without secrets", async () => {
    const s = await firstSignIn("tenant-a", await makeStaff(api.A, "dpo"));
    const me = await api.http().get("/v1/auth/me").set(bearer(s.token));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ role: "dpo", tenantId: api.A.id, scopes: ["dpo", "auditor"] });
    expect(JSON.stringify(me.body)).not.toMatch(/password|secret|scrypt/i);
  });

  test("a second sign-in asks for the code (no set-up), and a code that was already used is refused", async () => {
    const who = await makeStaff(api.A, "dpo");
    const first = await firstSignIn("tenant-a", who);
    const l = await login("tenant-a", who.email, who.password);
    expect(l.body.mfa).toBe("verify");
    expect((await api.http().post("/v1/auth/mfa/enroll").send({ challenge: l.body.challenge })).status).toBe(409);
    const code = totpAt(first.secret, Date.now() + 30_000); // the next step: one step of clock drift is allowed
    const ok = await api.http().post("/v1/auth/mfa/verify").send({ challenge: l.body.challenge, code });
    expect(ok.status).toBe(200);
    expect(ok.body).not.toHaveProperty("recoveryCodes");
    const l2 = await login("tenant-a", who.email, who.password);
    const replay = await api.http().post("/v1/auth/mfa/verify").send({ challenge: l2.body.challenge, code });
    expect(replay.status).toBe(401);
    const firstCodeAgain = await api.http().post("/v1/auth/mfa/verify").send({ challenge: l2.body.challenge, code: totpAt(first.secret, Date.now()) });
    expect(firstCodeAgain.status).toBe(401);
  });
});

describe("what each role may do", () => {
  test("a DPO session works the DPO queue and the audit check, not the admin routes; a tenant admin the reverse", async () => {
    const dpo = await firstSignIn("tenant-a", await makeStaff(api.A, "dpo"));
    const admin = await firstSignIn("tenant-a", await makeStaff(api.A, "tenant_admin"));
    expect((await api.http().get("/v1/dsr").set(bearer(dpo.token))).status).toBe(200);
    expect((await api.http().get("/v1/audit/verify").set(bearer(dpo.token))).status).toBe(200);
    expect((await api.http().get("/v1/webhook-endpoints").set(bearer(dpo.token))).status).toBe(403);
    expect((await api.http().get("/v1/webhook-endpoints").set(bearer(admin.token))).status).toBe(200);
    expect((await api.http().get("/v1/audit/verify").set(bearer(admin.token))).status).toBe(200);
    expect((await api.http().get("/v1/dsr").set(bearer(admin.token))).status).toBe(403);
    expect((await api.http().post("/v1/consents").set(bearer(dpo.token)).send({})).status).toBe(403); // a person's consent is not for staff
  });

  test("a session only sees its own tenant", async () => {
    const a = await firstSignIn("tenant-a", await makeStaff(api.A, "dpo"));
    const bReq = await api.http().post("/v1/dsr").set(bearer(api.B.pk)).send({ type: "access", identifier: "+919970000001" });
    const list = (await api.http().get("/v1/dsr").set(bearer(a.token))).body as { id: string }[];
    expect(list.map((r) => r.id)).not.toContain(bReq.body.id);
    expect((await api.http().get(`/v1/dsr/${bReq.body.id}`).set(bearer(a.token))).status).toBe(404);
  });

  test("actions by a signed-in person are audited under their staff id", async () => {
    const who = await makeStaff(api.A, "dpo");
    const s = await firstSignIn("tenant-a", who);
    const r = await api.http().post("/v1/dsr").set(bearer(api.A.pk)).send({ type: "access", identifier: "+919970000002" });
    await api.http().post(`/v1/dsr/${r.body.id}/transition`).set(bearer(s.token)).send({ to: "in_review" });
    const entry = (await owner("SELECT actor_type, actor_id FROM consent_audit_log WHERE tenant_id = $1 AND action = 'dsr.transitioned' AND ref_id = $2", [api.A.id, r.body.id]))[0];
    expect(entry).toEqual({ actor_type: "dpo", actor_id: `staff:${who.id}` });
  });
});

describe("failing to sign in", () => {
  test("an unknown tenant, an unknown email and a wrong password all get exactly the same answer", async () => {
    const who = await makeStaff(api.A, "dpo");
    const bad = [
      await login("no-such-tenant", who.email, PASSWORD),
      await login("tenant-a", "nobody@example.org", PASSWORD),
      await login("tenant-a", who.email, "wrong password entirely"),
      await login("tenant-b", who.email, PASSWORD), // the right person, in the wrong tenant
    ];
    for (const r of bad) {
      expect(r.status).toBe(401);
      expect(r.body.message).toBe("invalid credentials");
    }
    expect(new Set(bad.map((r) => JSON.stringify(r.body))).size).toBe(1);
  });

  test.each([
    ["no body", {}],
    ["a non-text password", { tenant: "tenant-a", email: "a@example.org", password: 5 }],
    ["an email that is not an address", { tenant: "tenant-a", email: "nope", password: PASSWORD }],
    ["a tenant that is not a slug", { tenant: "Not A Slug!", email: "a@example.org", password: PASSWORD }],
    ["a password over 128 characters", { tenant: "tenant-a", email: "a@example.org", password: "x".repeat(129) }],
  ])("%s is 400", async (_n, body) => {
    expect((await api.http().post("/v1/auth/login").send(body)).status).toBe(400);
  });

  test("five wrong passwords lock the account for 15 minutes, even against the right password, and it is audited", async () => {
    const who = await makeStaff(api.A, "dpo");
    await firstSignIn("tenant-a", who);
    for (let i = 0; i < 5; i++) expect((await login("tenant-a", who.email, `wrong password ${String(i)}`)).status).toBe(401);
    expect((await login("tenant-a", who.email, who.password)).status).toBe(401);
    const row = (await owner("SELECT locked_until FROM staff_users WHERE id = $1", [who.id]))[0] as { locked_until: Date };
    const minutes = (row.locked_until.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
    expect((await owner("SELECT count(*)::int AS n FROM consent_audit_log WHERE tenant_id = $1 AND action = 'staff.locked' AND ref_id = $2", [api.A.id, who.id]))[0]?.n).toBe(1);
    await owner("UPDATE staff_users SET locked_until = now() - interval '1 minute' WHERE id = $1", [who.id]);
    expect((await login("tenant-a", who.email, who.password)).status).toBe(200);
  });

  test("five wrong authenticator codes lock it too, and a wrong code never gives a session", async () => {
    const who = await makeStaff(api.A, "dpo");
    await firstSignIn("tenant-a", who);
    const l = await login("tenant-a", who.email, who.password);
    for (let i = 0; i < 5; i++) {
      const r = await api.http().post("/v1/auth/mfa/verify").send({ challenge: l.body.challenge, code: "000000" });
      expect(r.status).toBe(401);
      expect(r.body.message).toBe("invalid credentials");
    }
    expect((await owner("SELECT locked_until FROM staff_users WHERE id = $1", [who.id]))[0]?.locked_until).not.toBeNull();
  });

  test("a complete sign-in (password and code) resets the failure count", async () => {
    const who = await makeStaff(api.A, "dpo");
    const first = await firstSignIn("tenant-a", who);
    for (let i = 0; i < 3; i++) await login("tenant-a", who.email, "wrong password!!");
    expect((await owner("SELECT failed_attempts FROM staff_users WHERE id = $1", [who.id]))[0]?.failed_attempts).toBe(3);
    const l = await login("tenant-a", who.email, who.password);
    expect((await owner("SELECT failed_attempts FROM staff_users WHERE id = $1", [who.id]))[0]?.failed_attempts).toBe(3); // the password alone is not a sign-in
    const v = await api.http().post("/v1/auth/mfa/verify").send({ challenge: l.body.challenge, code: totpAt(first.secret, Date.now() + 30_000) });
    expect(v.status).toBe(200);
    expect((await owner("SELECT failed_attempts FROM staff_users WHERE id = $1", [who.id]))[0]?.failed_attempts).toBe(0);
  });
});

describe("recovery codes", () => {
  test("a recovery code signs in once instead of the authenticator code, and cannot be used again", async () => {
    const who = await makeStaff(api.A, "dpo");
    const first = await firstSignIn("tenant-a", who);
    const code = first.verify.body.recoveryCodes[0] as string;
    const l = await login("tenant-a", who.email, who.password);
    const ok = await api.http().post("/v1/auth/mfa/verify").send({ challenge: l.body.challenge, code });
    expect(ok.status).toBe(200);
    const l2 = await login("tenant-a", who.email, who.password);
    expect((await api.http().post("/v1/auth/mfa/verify").send({ challenge: l2.body.challenge, code })).status).toBe(401);
    const other = first.verify.body.recoveryCodes[1] as string;
    expect((await api.http().post("/v1/auth/mfa/verify").send({ challenge: l2.body.challenge, code: other.toUpperCase() })).status).toBe(200); // case does not matter
  });

  test("only hashes of the codes are stored", async () => {
    const who = await makeStaff(api.A, "dpo");
    const first = await firstSignIn("tenant-a", who);
    const stored = (await owner("SELECT code_hash FROM staff_recovery_codes WHERE staff_id = $1", [who.id])) as { code_hash: string }[];
    expect(stored).toHaveLength(8);
    for (const c of first.verify.body.recoveryCodes as string[]) expect(stored.map((s) => s.code_hash)).not.toContain(c);
  });
});

describe("tokens", () => {
  const forge = (over: Partial<TokenPayload>, purpose: "session" | "challenge" = "session"): string => {
    const now = Math.floor(Date.now() / 1000);
    return signToken(api.keys.sessionKey(), { purpose, sub: "00000000-0000-4000-8000-000000000001", tid: api.A.id, role: "dpo", ver: 1, iat: now, exp: now + 900, auth: now, ...over });
  };

  test("a challenge (password only, no code yet) is not a session", async () => {
    const who = await makeStaff(api.A, "dpo");
    const l = await login("tenant-a", who.email, who.password);
    const r = await api.http().get("/v1/auth/me").set(bearer(l.body.challenge));
    expect(r.status).toBe(401);
    expect((await api.http().get("/v1/dsr").set(bearer(l.body.challenge))).status).toBe(401);
  });

  test("a session cannot be used as a challenge", async () => {
    const s = await firstSignIn("tenant-a", await makeStaff(api.A, "dpo"));
    expect((await api.http().post("/v1/auth/mfa/verify").send({ challenge: s.token, code: totpAt(s.secret, Date.now()) })).status).toBe(401);
    expect((await api.http().post("/v1/auth/mfa/enroll").send({ challenge: s.token })).status).toBe(401);
  });

  test("expired, tampered, wrongly signed, and unknown-user tokens are refused", async () => {
    const s = await firstSignIn("tenant-a", await makeStaff(api.A, "dpo"));
    const tampered = s.token.slice(0, -3) + (s.token.endsWith("AAA") ? "BBB" : "AAA");
    expect((await api.http().get("/v1/auth/me").set(bearer(tampered))).status).toBe(401);
    expect((await api.http().get("/v1/auth/me").set(bearer(forge({ iat: 1, exp: 2 })))).status).toBe(401);
    const wrongKey = signToken(new Uint8Array(32).fill(1), { purpose: "session", sub: "00000000-0000-4000-8000-000000000001", tid: api.A.id, role: "dpo", ver: 1, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900, auth: Math.floor(Date.now() / 1000) });
    expect((await api.http().get("/v1/auth/me").set(bearer(wrongKey))).status).toBe(401);
    expect((await api.http().get("/v1/auth/me").set(bearer(forge({})))).status).toBe(401); // a valid signature for a person who does not exist
  });

  test("a validly signed session for a person who never finished setting up the authenticator is refused", async () => {
    const who = await makeStaff(api.A, "dpo"); // created, never signed in
    expect((await api.http().get("/v1/auth/me").set(bearer(forge({ sub: who.id })))).status).toBe(401);
  });

  test("a disabled person, or a bumped session version, signs everyone out at once", async () => {
    const who = await makeStaff(api.A, "dpo");
    const s = await firstSignIn("tenant-a", who);
    expect((await api.http().get("/v1/auth/me").set(bearer(s.token))).status).toBe(200);
    await owner("UPDATE staff_users SET session_version = session_version + 1 WHERE id = $1", [who.id]);
    expect((await api.http().get("/v1/auth/me").set(bearer(s.token))).status).toBe(401);
    const who2 = await makeStaff(api.A, "dpo");
    const s2 = await firstSignIn("tenant-a", who2);
    await owner("UPDATE staff_users SET disabled_at = now() WHERE id = $1", [who2.id]);
    expect((await api.http().get("/v1/auth/me").set(bearer(s2.token))).status).toBe(401);
    expect((await login("tenant-a", who2.email, who2.password)).status).toBe(401);
  });

  test("a session from tenant A names tenant A even if its token is replayed against tenant B's data", async () => {
    const s = await firstSignIn("tenant-a", await makeStaff(api.A, "dpo"));
    const me = await api.http().get("/v1/auth/me").set(bearer(s.token));
    expect(me.body.tenantId).toBe(api.A.id);
    // A token claiming another tenant for the same person is refused: the person does not exist there.
    const claim = forge({ sub: (await owner("SELECT id FROM staff_users LIMIT 1"))[0]?.id as string, tid: api.B.id });
    expect((await api.http().get("/v1/auth/me").set(bearer(claim))).status).toBe(401);
  });
});

describe("refreshing", () => {
  test("a valid session buys a new one with a later expiry, until eight hours after the real sign-in", async () => {
    const who = await makeStaff(api.A, "dpo");
    const s = await firstSignIn("tenant-a", who);
    await new Promise((r) => setTimeout(r, 1100));
    const r = await api.http().post("/v1/auth/refresh").set(bearer(s.token));
    expect(r.status).toBe(200);
    expect(Date.parse(r.body.expiresAt)).toBeGreaterThan(Date.parse(s.verify.body.expiresAt));
    expect((await api.http().get("/v1/auth/me").set(bearer(r.body.token))).status).toBe(200);
    const now = Math.floor(Date.now() / 1000);
    const old = signToken(api.keys.sessionKey(), { purpose: "session", sub: who.id, tid: api.A.id, role: "dpo", ver: 1, iat: now, exp: now + 900, auth: now - 9 * 3600 });
    expect((await api.http().post("/v1/auth/refresh").set(bearer(old))).status).toBe(401);
  });

  test("an API key cannot refresh, and nothing refreshes without a session", async () => {
    expect((await api.http().post("/v1/auth/refresh").set(bearer(api.A.dpo))).status).toBe(403);
    expect((await api.http().post("/v1/auth/refresh")).status).toBe(401);
  });
});

describe("what is stored", () => {
  test("the email address and the password are never stored in the clear, and the authenticator secret only sealed", async () => {
    const email = "very.unique.person@example.org";
    const pw = "a very particular passphrase 9137";
    const who = await makeStaff(api.A, "dpo", email, pw);
    const s = await firstSignIn("tenant-a", { email, password: pw });
    const tables = (await owner("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")) as { tablename: string }[];
    for (const { tablename } of tables) {
      const dump = ((await owner(`SELECT coalesce(string_agg(t::text, ' '), '') AS s FROM ${tablename} t`))[0]?.s ?? "") as string;
      for (const needle of ["very.unique.person", pw, s.secret]) expect({ tablename, needle: needle.slice(0, 8), found: dump.includes(needle) }).toEqual({ tablename, needle: needle.slice(0, 8), found: false });
    }
    expect(who.id).toBeDefined();
  });

  test("signing in and enrolling are audit events, and the chain still verifies", async () => {
    const who = await makeStaff(api.A, "tenant_admin");
    await firstSignIn("tenant-a", who);
    const actions = (await owner("SELECT action FROM consent_audit_log WHERE tenant_id = $1 AND ref_id = $2 ORDER BY seq_no", [api.A.id, who.id])).map((r) => r.action);
    expect(actions).toEqual(["staff.mfa_enrolled", "staff.logged_in"]);
    expect((await api.http().get("/v1/audit/verify").set(bearer(api.A.auditor))).body.ok).toBe(true);
  });
});

describe("creating staff (operator tooling)", () => {
  test("refuses a weak password, a bad email, a second person with the same email, and an unknown role", async () => {
    const email = emailOf();
    await expect(createStaffUser(api.db.owner, api.keys, { tenantId: api.A.id, email, password: "short", role: "dpo" })).rejects.toThrow(/at least 12/);
    await expect(createStaffUser(api.db.owner, api.keys, { tenantId: api.A.id, email: "nope", password: PASSWORD, role: "dpo" })).rejects.toThrow(/email/);
    await expect(createStaffUser(api.db.owner, api.keys, { tenantId: api.A.id, email, password: PASSWORD, role: "root" as never })).rejects.toThrow(/role/);
    await makeStaff(api.A, "dpo", email);
    await expect(createStaffUser(api.db.owner, api.keys, { tenantId: api.A.id, email: email.toUpperCase(), password: PASSWORD, role: "dpo" })).rejects.toThrow(/unique|duplicate/);
  });
});

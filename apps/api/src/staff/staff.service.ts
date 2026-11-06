import { ConflictException, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { sha256Hex } from "@saral/audit-chain";
import type pg from "pg";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/access.js";
import type { Scope } from "../auth/api-keys.js";
import { decryptContact, encryptContact } from "../crypto/contact-crypto.js";
import { Database } from "../db/database.js";
import { KEY_PROVIDER, type KeyProvider } from "../keys/key-provider.js";
import { recoveryCodeHash } from "./staff-admin.js";
import { emailBlind } from "./staff-admin.js";
import { hashPassword, verifyPassword } from "./password.js";
import { signToken, verifyToken, type StaffRole, type TokenPayload } from "./session-token.js";
import { base32Decode, base32Encode, generateTotpSecret, otpauthUrl, verifyTotp } from "./totp.js";

type Staff = {
  id: string; tenant_id: string; email_sealed: Buffer; role: StaffRole; password_hash: string; totp_secret_sealed: Buffer | null;
  totp_confirmed_at: Date | null; last_totp_step: string; failed_attempts: number; locked_until: Date | null; session_version: number; disabled_at: Date | null;
};

const INVALID = "invalid credentials";
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
const CHALLENGE_SECONDS = 300;
const SESSION_SECONDS = 900;
/** However often it is refreshed, a session ends this long after the person last signed in with a password and a code. */
export const SESSION_MAX_SECONDS = 8 * 3600;
const RECOVERY_CODES = 8;
const ISSUER = "Saral Privacy";

export const ROLE_SCOPES: Record<StaffRole, Scope[]> = { tenant_admin: ["tenant_admin", "auditor"], dpo: ["dpo", "auditor"] };

export interface SessionResult {
  token: string;
  expiresAt: string;
  role: StaffRole;
  recoveryCodes?: string[];
}

@Injectable()
export class StaffService {
  private dummy: Promise<string> | undefined;

  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
  ) {}

  /** A hash to check a password against when the person does not exist, so an unknown email takes as long as a wrong password. */
  private dummyHash(): Promise<string> {
    return (this.dummy ??= hashPassword("not a real password, only here to take the same time"));
  }

  private issue(row: { id: string; tenant_id: string; role: StaffRole; session_version: number }, purpose: TokenPayload["purpose"], seconds: number, authAt: number): { token: string; expiresAt: string } {
    const now = Math.floor(Date.now() / 1000);
    const token = signToken(this.keys.sessionKey(), { purpose, sub: row.id, tid: row.tenant_id, role: row.role, ver: row.session_version, iat: now, exp: now + seconds, auth: authAt });
    return { token, expiresAt: new Date((now + seconds) * 1000).toISOString() };
  }

  private async record(c: pg.PoolClient, row: Staff, action: string): Promise<void> {
    await this.audit.append(c, row.tenant_id, {
      actorType: row.role === "dpo" ? "dpo" : "system", actorId: `staff:${row.id}`, action, refTable: "staff_users", refId: row.id,
      payloadSha256: sha256Hex(JSON.stringify(["saral.staff", 1, row.tenant_id, row.id, row.role, action])),
    });
  }

  /** Counts a failure, and locks the account for 15 minutes on the fifth. Runs inside the caller's transaction, which commits. */
  private async fail(c: pg.PoolClient, row: Staff): Promise<void> {
    const attempts = row.failed_attempts + 1;
    if (attempts >= MAX_FAILURES) {
      await c.query("UPDATE staff_users SET failed_attempts = 0, locked_until = now() + make_interval(mins => $2) WHERE id = $1", [row.id, LOCK_MINUTES]);
      await this.record(c, row, "staff.locked");
    } else {
      await c.query("UPDATE staff_users SET failed_attempts = $2 WHERE id = $1", [row.id, attempts]);
    }
  }

  private locked(row: Staff): boolean {
    return row.locked_until !== null && row.locked_until.getTime() > Date.now();
  }

  /** Step one: the password. Gives a short-lived challenge, never a session. Every failure is the same 401. */
  async login(slug: string, email: string, password: string): Promise<{ challenge: string; mfa: "enroll" | "verify" }> {
    const tenantId = await this.db.inScope({ tenantSlug: slug }, async (c) => (await c.query<{ id: string }>("SELECT id FROM tenants")).rows[0]?.id);
    if (tenantId === undefined) {
      await verifyPassword(password, await this.dummyHash());
      throw new UnauthorizedException(INVALID);
    }
    const outcome = await this.db.inScope({ tenantId }, async (c) => {
      await c.query("SELECT audit_append_lock($1)", [tenantId]);
      const row = (await c.query<Staff>("SELECT * FROM staff_users WHERE email_blind = $1 AND disabled_at IS NULL FOR UPDATE", [emailBlind(this.keys, tenantId, email)])).rows[0];
      // The password is always checked, even for an unknown or locked account, so timing does not say which it was.
      const ok = await verifyPassword(password, row?.password_hash ?? (await this.dummyHash()));
      if (row === undefined || this.locked(row)) return undefined;
      if (!ok) {
        await this.fail(c, row);
        return undefined;
      }
      return row;
    });
    if (outcome === undefined) throw new UnauthorizedException(INVALID);
    return { challenge: this.issue(outcome, "challenge", CHALLENGE_SECONDS, Math.floor(Date.now() / 1000)).token, mfa: outcome.totp_confirmed_at ? "verify" : "enroll" };
  }

  /** Loads the person a challenge or session names, and refuses it if they are gone, disabled or signed out everywhere. */
  private async staffFor(c: pg.PoolClient, payload: TokenPayload, lock: boolean): Promise<Staff | undefined> {
    const row = (await c.query<Staff>(`SELECT * FROM staff_users WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`, [payload.sub])).rows[0];
    return row !== undefined && row.disabled_at === null && row.session_version === payload.ver ? row : undefined;
  }

  private challenge(token: string): TokenPayload {
    const v = verifyToken(this.keys.sessionKey(), token, "challenge", Date.now());
    if (!v.ok) throw new UnauthorizedException(INVALID);
    return v.payload;
  }

  /** Step two, first time only: a new authenticator secret to scan. It is not trusted until a code from it is accepted. */
  async enroll(challengeToken: string): Promise<{ secret: string; otpauthUrl: string }> {
    const p = this.challenge(challengeToken);
    return this.db.inScope({ tenantId: p.tid }, async (c) => {
      const row = await this.staffFor(c, p, true);
      if (row === undefined || this.locked(row)) throw new UnauthorizedException(INVALID);
      if (row.totp_confirmed_at !== null) throw new ConflictException({ error: "already_enrolled", message: "an authenticator is already set up" });
      const secret = generateTotpSecret();
      await c.query("UPDATE staff_users SET totp_secret_sealed = $2 WHERE id = $1", [row.id, Buffer.from(encryptContact(this.keys.contactKey(), row.tenant_id, `totp:${row.id}`, base32Encode(secret)))]);
      const email = decryptContact(this.keys.contactKey(), row.tenant_id, `email:${row.id}`, new Uint8Array(row.email_sealed));
      return { secret: base32Encode(secret), otpauthUrl: otpauthUrl(secret, ISSUER, email) };
    });
  }

  private newRecoveryCodes(): string[] {
    return Array.from({ length: RECOVERY_CODES }, () => {
      const t = base32Encode(new Uint8Array(randomBytes(7))).slice(0, 10).toLowerCase();
      return `${t.slice(0, 5)}-${t.slice(5)}`;
    });
  }

  /** Step two: an authenticator code (or a recovery code). On success, and only then, a session. */
  async verifyMfa(challengeToken: string, code: string): Promise<SessionResult> {
    const p = this.challenge(challengeToken);
    const result = await this.db.inScope({ tenantId: p.tid }, async (c) => {
      await c.query("SELECT audit_append_lock($1)", [p.tid]);
      const row = await this.staffFor(c, p, true);
      if (row === undefined || this.locked(row)) return undefined;
      if (row.totp_secret_sealed === null) throw new ConflictException({ error: "not_enrolled", message: "set up the authenticator first" });
      const confirmed = row.totp_confirmed_at !== null;
      const normalised = code.trim();
      let accepted = false;
      let step: bigint | undefined;
      if (/^[0-9]{6}$/.test(normalised)) {
        const secret = base32Decode(decryptContact(this.keys.contactKey(), row.tenant_id, `totp:${row.id}`, new Uint8Array(row.totp_secret_sealed)));
        const r = verifyTotp(secret, normalised, Date.now(), BigInt(row.last_totp_step));
        if (r.ok) {
          accepted = true;
          step = r.step;
        }
      } else if (confirmed && /^[a-z2-7]{5}-[a-z2-7]{5}$/i.test(normalised)) {
        const used = await c.query("UPDATE staff_recovery_codes SET used_at = now() WHERE staff_id = $1 AND code_hash = $2 AND used_at IS NULL", [row.id, recoveryCodeHash(this.keys, row.tenant_id, row.id, normalised)]);
        accepted = used.rowCount === 1;
      }
      if (!accepted) {
        await this.fail(c, row);
        return undefined;
      }
      let recoveryCodes: string[] | undefined;
      if (!confirmed) {
        await c.query("UPDATE staff_users SET totp_confirmed_at = now() WHERE id = $1", [row.id]);
        await c.query("DELETE FROM staff_recovery_codes WHERE staff_id = $1", [row.id]);
        recoveryCodes = this.newRecoveryCodes();
        for (const rc of recoveryCodes) await c.query("INSERT INTO staff_recovery_codes (tenant_id, staff_id, code_hash) VALUES ($1, $2, $3)", [row.tenant_id, row.id, recoveryCodeHash(this.keys, row.tenant_id, row.id, rc)]);
        await this.record(c, row, "staff.mfa_enrolled");
      }
      await c.query("UPDATE staff_users SET failed_attempts = 0, locked_until = NULL, last_totp_step = COALESCE($2, last_totp_step) WHERE id = $1", [row.id, step === undefined ? null : step.toString()]);
      await this.record(c, row, "staff.logged_in");
      return { row, recoveryCodes };
    });
    if (result === undefined) throw new UnauthorizedException(INVALID);
    const s = this.issue(result.row, "session", SESSION_SECONDS, p.auth);
    return { ...s, role: result.row.role, ...(result.recoveryCodes ? { recoveryCodes: result.recoveryCodes } : {}) };
  }

  /** Called by the guard for every request that carries a session token. Returns undefined for anything that is not valid right now. */
  async authenticate(token: string): Promise<AuthContext | undefined> {
    const v = verifyToken(this.keys.sessionKey(), token, "session", Date.now());
    if (!v.ok) return undefined;
    const p = v.payload;
    const row = await this.db.inScope({ tenantId: p.tid }, (c) => this.staffFor(c, p, false));
    if (row === undefined || row.totp_confirmed_at === null || row.role !== p.role) return undefined;
    return { actor: `staff:${row.id}`, keyId: row.id, tenantId: row.tenant_id, kind: "session", scopes: ROLE_SCOPES[row.role], role: row.role, authAt: p.auth, sessionVersion: row.session_version };
  }

  async refresh(auth: AuthContext): Promise<SessionResult> {
    if (auth.kind !== "session" || auth.role === undefined || auth.authAt === undefined || auth.sessionVersion === undefined) {
      throw new ForbiddenException("only a signed-in person can refresh a session");
    }
    if (Math.floor(Date.now() / 1000) - auth.authAt >= SESSION_MAX_SECONDS) throw new UnauthorizedException("the session has reached its limit; sign in again");
    const s = this.issue({ id: auth.keyId, tenant_id: auth.tenantId, role: auth.role, session_version: auth.sessionVersion }, "session", SESSION_SECONDS, auth.authAt);
    return { ...s, role: auth.role };
  }

  async me(auth: AuthContext): Promise<{ staffId: string; email: string | null; role: StaffRole | null; tenantId: string; scopes: Scope[] }> {
    let email: string | null = null;
    if (auth.kind === "session") {
      email = await this.db.inScope({ tenantId: auth.tenantId }, async (c) => {
        const r = (await c.query<{ email_sealed: Buffer }>("SELECT email_sealed FROM staff_users WHERE id = $1", [auth.keyId])).rows[0];
        return r ? decryptContact(this.keys.contactKey(), auth.tenantId, `email:${auth.keyId}`, new Uint8Array(r.email_sealed)) : null;
      });
    }
    return { staffId: auth.keyId, email, role: auth.role ?? null, tenantId: auth.tenantId, scopes: auth.scopes };
  }
}

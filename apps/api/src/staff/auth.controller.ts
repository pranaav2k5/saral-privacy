import { Body, Controller, Get, HttpCode, Post } from "@nestjs/common";
import { Auth, Public, Scopes, type AuthContext } from "../auth/access.js";
import { bad, objectBody } from "../http/validate.js";
import { PASSWORD_MAX } from "./password.js";
import { normalizeEmail } from "./staff-admin.js";
import { StaffService } from "./staff.service.js";

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

const text = (v: unknown, field: string, max: number): string => {
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw bad(field, `must be text of 1 to ${String(max)} characters`);
  return v;
};

@Controller("v1/auth")
export class AuthController {
  constructor(private readonly staff: StaffService) {}

  /** Step one of signing in: the password. Returns a short-lived challenge, not a session. */
  @Post("login")
  @HttpCode(200)
  @Public()
  login(@Body() raw: unknown) {
    const body = objectBody(raw);
    const tenant = text(body.tenant, "tenant", 63);
    if (!SLUG.test(tenant)) throw bad("tenant", "must be the organisation's short name (lowercase letters, digits, dashes)");
    const email = normalizeEmail(body.email);
    if (email === null) throw bad("email", "must be an email address");
    return this.staff.login(tenant, email, text(body.password, "password", PASSWORD_MAX));
  }

  /** First time only: a new authenticator secret to scan. */
  @Post("mfa/enroll")
  @HttpCode(200)
  @Public()
  enroll(@Body() raw: unknown) {
    return this.staff.enroll(text(objectBody(raw).challenge, "challenge", 2000));
  }

  /** Step two: the authenticator code (or a recovery code). Returns the session. */
  @Post("mfa/verify")
  @HttpCode(200)
  @Public()
  verify(@Body() raw: unknown) {
    const body = objectBody(raw);
    return this.staff.verifyMfa(text(body.challenge, "challenge", 2000), text(body.code, "code", 20));
  }

  /** Exchanges a valid session for a new one, until eight hours after the person last signed in. */
  @Post("refresh")
  @HttpCode(200)
  @Scopes("tenant_admin", "dpo")
  refresh(@Auth() auth: AuthContext) {
    return this.staff.refresh(auth);
  }

  /** Changes the signed-in person's own password. The answer is a new session; every other session of theirs ends. */
  @Post("password")
  @HttpCode(200)
  @Scopes("tenant_admin", "dpo")
  changePassword(@Auth() auth: AuthContext, @Body() raw: unknown) {
    const body = objectBody(raw);
    // The new password may be longer than the policy allows, so that the policy can say so in words.
    return this.staff.changePassword(auth, text(body.currentPassword, "currentPassword", PASSWORD_MAX), text(body.newPassword, "newPassword", 1024));
  }

  @Get("me")
  @Scopes("tenant_admin", "dpo")
  me(@Auth() auth: AuthContext) {
    return this.staff.me(auth);
  }
}

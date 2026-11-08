import { Body, Controller, Get, HttpCode, Post, Query } from "@nestjs/common";
import { Auth, Scopes, type AuthContext } from "../auth/access.js";
import { bad, normalizeIdentifier, objectBody } from "../http/validate.js";
import { ConsentReviewService, DEFAULT_SUMMARY_DAYS, MAX_SUMMARY_DAYS } from "./consent-review.service.js";

/** What the data protection officer sees of consents. The officer's role only: finding a person's consents is access to personal data. */
@Controller("v1/consents")
export class ConsentReviewController {
  constructor(private readonly review: ConsentReviewService) {}

  /** A POST, so that the identifier is in the body and not in an address that servers and browsers keep. */
  @Post("search")
  @HttpCode(200)
  @Scopes("dpo")
  search(@Auth() auth: AuthContext, @Body() raw: unknown) {
    return this.review.search(auth, normalizeIdentifier(objectBody(raw).identifier));
  }

  @Get("summary")
  @Scopes("dpo")
  summary(@Auth() auth: AuthContext, @Query("days") days?: unknown) {
    let n = DEFAULT_SUMMARY_DAYS;
    if (days !== undefined) {
      if (typeof days !== "string" || !/^[1-9][0-9]{0,2}$/.test(days) || Number(days) > MAX_SUMMARY_DAYS) throw bad("days", `must be a whole number from 1 to ${String(MAX_SUMMARY_DAYS)}`);
      n = Number(days);
    }
    return this.review.summary(auth.tenantId, n);
  }
}

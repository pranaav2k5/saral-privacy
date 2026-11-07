import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/access.js";
import { SkipThrottle } from "../ratelimit/throttle.js";

@Controller()
export class HealthController {
  /** Liveness only: must not touch the database or any other dependency. */
  @Get("healthz")
  @Public()
  @SkipThrottle()
  check(): { status: "ok" } {
    return { status: "ok" };
  }
}

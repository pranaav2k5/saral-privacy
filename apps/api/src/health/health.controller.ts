import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/access.js";

@Controller()
export class HealthController {
  /** Liveness only: must not touch the database or any other dependency. */
  @Get("healthz")
  @Public()
  check(): { status: "ok" } {
    return { status: "ok" };
  }
}

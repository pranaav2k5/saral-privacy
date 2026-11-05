import { Controller, Get } from "@nestjs/common";

@Controller()
export class HealthController {
  /** Liveness only: must not touch the database or any other dependency. */
  @Get("healthz")
  check(): { status: "ok" } {
    return { status: "ok" };
  }
}

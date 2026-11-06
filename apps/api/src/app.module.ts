import { Module } from "@nestjs/common";
import { ApiModule } from "./api.module.js";
import { HealthController } from "./health/health.controller.js";

@Module({ imports: [ApiModule], controllers: [HealthController] })
export class AppModule {}

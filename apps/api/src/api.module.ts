import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuditController } from "./audit/audit.controller.js";
import { AuditService } from "./audit/audit.service.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { ConsentsController } from "./consent/consent.controller.js";
import { ConsentService } from "./consent/consent.service.js";
import { Database } from "./db/database.js";
import { KEY_PROVIDER, createKeyProvider } from "./keys/key-provider.js";
import { NoticesController } from "./notices/notices.controller.js";
import { SETTINGS, readSettings, type Settings } from "./settings.js";
import { JwksController } from "./wellknown/jwks.controller.js";

@Module({
  controllers: [ConsentsController, NoticesController, JwksController, AuditController],
  providers: [
    { provide: SETTINGS, useFactory: () => readSettings(process.env) },
    { provide: KEY_PROVIDER, useFactory: (settings: Settings) => createKeyProvider(settings), inject: [SETTINGS] },
    Database,
    AuditService,
    ConsentService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class ApiModule {}

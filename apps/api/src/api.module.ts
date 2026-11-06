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
import { createHttpsClient } from "./webhooks/http-client.js";
import { WebhookRunner } from "./webhooks/runner.js";
import { URL_RESOLVER, WEBHOOK_HTTP } from "./webhooks/tokens.js";
import { systemResolver } from "./webhooks/url-guard.js";
import { WebhookEndpointsController } from "./webhooks/webhook-endpoints.controller.js";
import { WebhookService } from "./webhooks/webhook.service.js";
import { WebhookWorker } from "./webhooks/worker.js";

@Module({
  controllers: [ConsentsController, NoticesController, JwksController, AuditController, WebhookEndpointsController],
  providers: [
    { provide: SETTINGS, useFactory: () => readSettings(process.env) },
    { provide: KEY_PROVIDER, useFactory: (settings: Settings) => createKeyProvider(settings), inject: [SETTINGS] },
    Database,
    AuditService,
    ConsentService,
    WebhookService,
    WebhookWorker,
    WebhookRunner,
    { provide: URL_RESOLVER, useValue: systemResolver },
    { provide: WEBHOOK_HTTP, useFactory: () => createHttpsClient({ resolver: systemResolver }) },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class ApiModule {}

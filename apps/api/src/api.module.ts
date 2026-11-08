import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuditController } from "./audit/audit.controller.js";
import { AnchorJob } from "./audit/anchor-job.js";
import { AuditService } from "./audit/audit.service.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { DEFAULT_LIMITS, RATE_LIMITS, RATE_LIMIT_CLOCK } from "./ratelimit/policies.js";
import { IpRateLimitGuard, PrincipalRateLimitGuard } from "./ratelimit/rate-limit.guard.js";
import { RateLimitService } from "./ratelimit/rate-limit.service.js";
import { ConsentsController } from "./consent/consent.controller.js";
import { ConsentService } from "./consent/consent.service.js";
import { Database } from "./db/database.js";
import { DsrController } from "./dsr/dsr.controller.js";
import { DsrService } from "./dsr/dsr.service.js";
import { PrincipalService } from "./principals/principal.service.js";
import { KEY_PROVIDER, createKeyProvider } from "./keys/key-provider.js";
import { NoticesController } from "./notices/notices.controller.js";
import { SETTINGS, readSettings, type Settings } from "./settings.js";
import { AuthController } from "./staff/auth.controller.js";
import { StaffService } from "./staff/staff.service.js";
import { JwksController } from "./wellknown/jwks.controller.js";
import { createHttpsClient } from "./webhooks/http-client.js";
import { WebhookRunner } from "./webhooks/runner.js";
import { URL_RESOLVER, WEBHOOK_HTTP } from "./webhooks/tokens.js";
import { systemResolver } from "./webhooks/url-guard.js";
import { WebhookEndpointsController } from "./webhooks/webhook-endpoints.controller.js";
import { WebhookService } from "./webhooks/webhook.service.js";
import { WebhookWorker } from "./webhooks/worker.js";
import { NoticeService } from "./notices/notice.service.js";

@Module({
  controllers: [AuthController, DsrController, ConsentsController, NoticesController, JwksController, AuditController, WebhookEndpointsController],
  providers: [
    { provide: SETTINGS, useFactory: () => readSettings(process.env) },
    { provide: KEY_PROVIDER, useFactory: (settings: Settings) => createKeyProvider(settings), inject: [SETTINGS] },
    Database,
    AuditService,
    AnchorJob,
    PrincipalService,
    ConsentService,
    NoticeService,
    DsrService,
    StaffService,
    WebhookService,
    WebhookWorker,
    WebhookRunner,
    { provide: URL_RESOLVER, useValue: systemResolver },
    { provide: WEBHOOK_HTTP, useFactory: () => createHttpsClient({ resolver: systemResolver }) },
    { provide: RATE_LIMITS, useValue: DEFAULT_LIMITS },
    { provide: RATE_LIMIT_CLOCK, useValue: Date.now },
    RateLimitService,
    // In this order: by address before anything is looked up, then who the caller is, then by key or session.
    { provide: APP_GUARD, useClass: IpRateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PrincipalRateLimitGuard },
  ],
})
export class ApiModule {}

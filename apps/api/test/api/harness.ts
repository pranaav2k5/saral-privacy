import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../../src/app.module.js";
import { issueApiKey } from "../../src/auth/api-keys.js";
import { KEY_PROVIDER, type KeyProvider } from "../../src/keys/key-provider.js";
import { SETTINGS, type Settings } from "../../src/settings.js";
import { URL_RESOLVER, WEBHOOK_HTTP, type WebhookHttp, type WebhookRequest } from "../../src/webhooks/tokens.js";
import type { Resolver } from "../../src/webhooks/url-guard.js";
import { NOTICE_TEXT, TENANT_A, TENANT_B, createTestDb, sha256, uid, type TestDb } from "../db/helpers.js";

export const MASTER = "test-master-secret-that-is-at-least-32-characters-long";
export const PHONE = "+919876543210";
export const ORIGIN = "https://shop.example.org";

export const DEFINITIONS = [
  {
    key: "analytics",
    purpose: "Understand how the app is used",
    purposeCategory: ["analytics"],
    piiCategory: ["device type"],
    termination: "https://example.org/privacy#withdraw",
    retentionDays: 365,
    thirdPartyDisclosure: false,
  },
  {
    key: "marketing",
    purpose: "Send product updates",
    purposeCategory: ["marketing"],
    piiCategory: ["email address"],
    termination: "https://example.org/privacy#withdraw",
    retentionDays: 180,
    thirdPartyDisclosure: true,
    thirdPartyName: "Example Mail Service Ltd",
  },
];

const PROFILE = {
  controller: {
    piiController: "Example Controller Pvt Ltd",
    contact: "Grievance Officer",
    address: { streetAddress: "1 Example Road", addressLocality: "Bengaluru", postalCode: "560001", addressCountry: "IN" },
    email: "privacy@example.org",
    phone: "tel:+91-00000-00000",
  },
  policyUrl: "https://example.org/privacy",
  service: "Example app",
};

export interface Tenant {
  id: string;
  noticeId: string;
  pk: string;
  admin: string;
  auditor: string;
  dpo: string;
}

/** Stands in for the network: records every webhook request and answers as scripted. */
export class FakeWebhookHttp implements WebhookHttp {
  calls: WebhookRequest[] = [];
  /** Statuses to answer with, oldest first; `"throw"` simulates a network failure. The last one repeats. */
  script: (number | "throw")[] = [200];
  async post(request: WebhookRequest): Promise<{ status: number }> {
    this.calls.push(request);
    const next = this.script.length > 1 ? (this.script.shift() as number | "throw") : (this.script[0] as number | "throw");
    if (next === "throw") throw new Error("connect ECONNREFUSED");
    return { status: next };
  }
}

/** Names ending in .example.org are public; `internal.example` points at a private address. */
export const fakeResolver: Resolver = async (host) => {
  if (host === "internal.example") return ["10.0.0.5"];
  if (host.endsWith(".example.org")) return ["93.184.216.34"];
  throw new Error("ENOTFOUND");
};

export interface Api {
  app: INestApplication;
  db: TestDb;
  keys: KeyProvider;
  hooks: FakeWebhookHttp;
  A: Tenant;
  B: Tenant;
  http: () => ReturnType<typeof request>;
  grant: (tenant: Tenant, body?: Record<string, unknown>) => Promise<request.Response>;
  stop: () => Promise<void>;
}

export async function startApi(): Promise<Api> {
  const db = await createTestDb();
  const settings: Settings = { databaseUrl: db.url, nodeEnv: "test", devMasterSecret: MASTER };
  const hooks = new FakeWebhookHttp();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SETTINGS).useValue(settings)
    .overrideProvider(WEBHOOK_HTTP).useValue(hooks)
    .overrideProvider(URL_RESOLVER).useValue(fakeResolver)
    .compile();
  const app = moduleRef.createNestApplication();
  // Listen once on an ephemeral port: supertest then reuses the server instead of adding a listener per request.
  await app.listen(0, "127.0.0.1");
  const keys = app.get<KeyProvider>(KEY_PROVIDER);

  async function tenant(id: string, family: string, slug: string): Promise<Tenant> {
    await db.owner.query("INSERT INTO tenants (id, name, slug, profile) VALUES ($1, $2, $3, $4)", [id, `Tenant ${slug}`, slug, PROFILE]);
    const noticeId = uid(family, 2);
    await db.owner.query(
      `INSERT INTO privacy_notices (id, tenant_id, version, language, canonical_text, canonical_sha256, purpose_definitions)
       VALUES ($1, $2, 1, 'en', $3, $4, $5)`,
      [noticeId, id, NOTICE_TEXT, sha256(NOTICE_TEXT), JSON.stringify(DEFINITIONS)],
    );
    const pepper = keys.apiKeyPepper();
    const issue = async (kind: "publishable" | "secret", scopes: ("sdk" | "tenant_admin" | "dpo" | "auditor")[], name: string) =>
      (await issueApiKey(db.owner, pepper, { tenantId: id, kind, scopes, name })).token;
    return {
      id,
      noticeId,
      pk: await issue("publishable", ["sdk"], "web"),
      admin: await issue("secret", ["tenant_admin"], "admin"),
      auditor: await issue("secret", ["auditor"], "auditor"),
      dpo: await issue("secret", ["dpo"], "dpo"),
    };
  }

  const A = await tenant(TENANT_A, "a", "tenant-a");
  const B = await tenant(TENANT_B, "b", "tenant-b");
  const http = () => request(app.getHttpServer());
  const grant = (t: Tenant, body: Record<string, unknown> = {}) =>
    http()
      .post("/v1/consents")
      .set("Authorization", `Bearer ${t.pk}`)
      .send({
        noticeId: t.noticeId,
        identifier: PHONE,
        purposes: [
          { key: "analytics", granted: true },
          { key: "marketing", granted: false },
        ],
        ...body,
      });
  return {
    app,
    db,
    keys,
    hooks,
    A,
    B,
    http,
    grant,
    async stop() {
      await app.close();
      await db.drop();
    },
  };
}

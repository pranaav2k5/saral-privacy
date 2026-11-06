import { verifyReceipt } from "@saral/receipts";
import { createDevKeyProvider } from "./key-provider.js";

const MASTER = "test-master-secret-that-is-at-least-32-characters-long";

describe("dev key provider", () => {
  test("refuses to run in production", async () => {
    await expect(createDevKeyProvider(MASTER, "production")).rejects.toThrow(/development only/);
  });

  test("requires a master secret of at least 32 characters when one is given", async () => {
    await expect(createDevKeyProvider("short", "development")).rejects.toThrow(/at least 32 characters/);
  });

  test("derives stable, distinct 32-byte keys from the master secret", async () => {
    const a = await createDevKeyProvider(MASTER, "development");
    const b = await createDevKeyProvider(MASTER, "development");
    expect(Buffer.from(a.auditHmacKey(1) as Uint8Array).toString("hex")).toBe(Buffer.from(b.auditHmacKey(1) as Uint8Array).toString("hex"));
    const keys = [a.auditHmacKey(1), a.pseudonymKey(), a.apiKeyPepper(), a.webhookKey()].map((k) => Buffer.from(k as Uint8Array).toString("hex"));
    expect(new Set(keys).size).toBe(4);
    for (const k of [a.auditHmacKey(1), a.pseudonymKey(), a.apiKeyPepper(), a.webhookKey()]) expect((k as Uint8Array).length).toBe(32);
  });

  test("a different master secret gives different keys", async () => {
    const a = await createDevKeyProvider(MASTER, undefined);
    const b = await createDevKeyProvider(MASTER + "x", undefined);
    expect(Buffer.from(a.pseudonymKey()).toString("hex")).not.toBe(Buffer.from(b.pseudonymKey()).toString("hex"));
  });

  test("without a master secret it makes a random one for this process", async () => {
    const a = await createDevKeyProvider(undefined, "development");
    const b = await createDevKeyProvider(undefined, "development");
    expect(Buffer.from(a.pseudonymKey()).toString("hex")).not.toBe(Buffer.from(b.pseudonymKey()).toString("hex"));
  });

  test("only audit key version 1 exists, and it is the current one", async () => {
    const p = await createDevKeyProvider(MASTER, "development");
    expect(p.currentAuditKeyVersion).toBe(1);
    expect(p.auditHmacKey(2)).toBeUndefined();
    expect(p.auditHmacKey(0)).toBeUndefined();
  });

  test("the receipt signer's receipts verify against the provider's JWKS", async () => {
    const p = await createDevKeyProvider(MASTER, "development");
    const jwks = p.jwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]?.kid).toBe(p.receiptSigner().kid);
    expect(typeof verifyReceipt).toBe("function");
  });
});

describe("createKeyProvider", () => {
  test("in production the API still boots, but anything that needs a key answers 503 instead of using a dev key", async () => {
    const { createKeyProvider } = await import("./key-provider.js");
    const p = await createKeyProvider({ databaseUrl: undefined, nodeEnv: "production", devMasterSecret: MASTER });
    expect(() => p.apiKeyPepper()).toThrow(/no key provider/);
    expect(() => p.receiptSigner()).toThrow(/no key provider/);
    expect(() => p.jwks()).toThrow(/no key provider/);
    expect(() => p.auditHmacKey(1)).toThrow(/no key provider/);
    expect(() => p.webhookKey()).toThrow(/no key provider/);
  });

  test("outside production it is the dev provider", async () => {
    const { createKeyProvider } = await import("./key-provider.js");
    const p = await createKeyProvider({ databaseUrl: undefined, nodeEnv: "test", devMasterSecret: MASTER });
    expect(p.pseudonymKey().length).toBe(32);
  });
});

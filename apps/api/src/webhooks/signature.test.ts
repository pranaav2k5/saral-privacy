import { endpointSecret, signWebhook, verifyWebhookSignature } from "./signature.js";

const SECRET = new Uint8Array(32).fill(5);
const BODY = '{"id":"d1","type":"consent.granted"}';
const T = 1793957400;

describe("signWebhook", () => {
  test("is t=<unix>,v1=<hex HMAC-SHA256 of '<t>.<body>'>, matching an independent implementation (Python hmac)", () => {
    expect(signWebhook(SECRET, T, BODY)).toBe(`t=${String(T)},v1=a36643a0fdfbdeaeb6dcb3c9f0163097742f502382024f7fbef8f8d4948b209d`);
  });

  test("changes with the secret, the timestamp and every byte of the body", () => {
    const base = signWebhook(SECRET, T, BODY);
    expect(signWebhook(new Uint8Array(32).fill(6), T, BODY)).not.toBe(base);
    expect(signWebhook(SECRET, T + 1, BODY)).not.toBe(base);
    expect(signWebhook(SECRET, T, BODY + " ")).not.toBe(base);
  });

  test("rejects a secret shorter than 32 bytes and a non-integer timestamp", () => {
    expect(() => signWebhook(new Uint8Array(31), T, BODY)).toThrow(/32 bytes/);
    expect(() => signWebhook(SECRET, 1.5, BODY)).toThrow(/timestamp/);
  });
});

describe("verifyWebhookSignature (the reference check a tenant writes)", () => {
  const header = signWebhook(SECRET, T, BODY);

  test("accepts a fresh, correct signature", () => {
    expect(verifyWebhookSignature(SECRET, header, BODY, T + 10)).toBe(true);
  });

  test("rejects a replay outside the tolerance, in either direction", () => {
    expect(verifyWebhookSignature(SECRET, header, BODY, T + 301)).toBe(false);
    expect(verifyWebhookSignature(SECRET, header, BODY, T - 301)).toBe(false);
    expect(verifyWebhookSignature(SECRET, header, BODY, T + 300)).toBe(true);
    expect(verifyWebhookSignature(SECRET, header, BODY, T + 1000, 2000)).toBe(true);
  });

  test("rejects the wrong secret and a changed body", () => {
    expect(verifyWebhookSignature(new Uint8Array(32).fill(6), header, BODY, T)).toBe(false);
    expect(verifyWebhookSignature(SECRET, header, BODY.replace("d1", "d2"), T)).toBe(false);
  });

  test("accepts any one of several v1 values (secret rotation)", () => {
    const old = signWebhook(new Uint8Array(32).fill(7), T, BODY).split(",")[1];
    expect(verifyWebhookSignature(SECRET, `${header},${old}`, BODY, T)).toBe(true);
    expect(verifyWebhookSignature(SECRET, `t=${String(T)},${old},${header.split(",")[1]}`, BODY, T)).toBe(true);
  });

  test.each(["", "garbage", "t=abc,v1=00", `v1=${"0".repeat(64)}`, `t=${String(T)}`, `t=${String(T)},v1=zz`, `t=${String(T)},v2=${"0".repeat(64)}`, `t=-1,v1=${"0".repeat(64)}`, `t=${String(T)},t=${String(T)},v1=${"0".repeat(64)}`])(
    "rejects a malformed header %p without throwing",
    (h) => {
      expect(verifyWebhookSignature(SECRET, h, BODY, T)).toBe(false);
    },
  );
});

describe("endpointSecret", () => {
  const KEY = new Uint8Array(32).fill(9);
  const ID = "11111111-1111-4111-8111-111111111111";

  test("is HMAC(webhookKey, '<endpointId>:<version>'), matching an independent implementation", () => {
    expect(Buffer.from(endpointSecret(KEY, ID, 1)).toString("hex")).toBe("841208ed54b327959ebdeb3771c1ea071839a713d5895f7bf83dc246f33655bf");
  });

  test("differs per endpoint and per version, so rotation changes it and nothing is stored", () => {
    const a = Buffer.from(endpointSecret(KEY, ID, 1)).toString("hex");
    expect(Buffer.from(endpointSecret(KEY, ID, 2)).toString("hex")).not.toBe(a);
    expect(Buffer.from(endpointSecret(KEY, ID.replace("1", "2"), 1)).toString("hex")).not.toBe(a);
  });
});

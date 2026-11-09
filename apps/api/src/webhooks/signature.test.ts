import { SECRET_OVERLAP_MS, endpointSecret, previousSecretActive, signWebhook, verifyWebhookSignature } from "./signature.js";

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

describe("signing with a previous secret as well", () => {
  const current = new Uint8Array(32).fill(7);
  const previous = new Uint8Array(32).fill(9);
  const other = new Uint8Array(32).fill(11);
  const body = '{"id":"d1"}';

  test("puts the current secret's signature first and the previous one's after it, with one timestamp", () => {
    const header = signWebhook(current, 1_700_000_000, body, previous);
    const parts = header.split(",");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("t=1700000000");
    expect(parts[1]).toBe(signWebhook(current, 1_700_000_000, body).split(",")[1]);
    expect(parts[2]).toBe(`v1=${signWebhook(previous, 1_700_000_000, body).split("v1=")[1] as string}`);
  });

  test("a receiver that still holds the old secret and one that holds the new secret both accept it, and one with another secret does not", () => {
    const header = signWebhook(current, 1_700_000_000, body, previous);
    expect(verifyWebhookSignature(current, header, body, 1_700_000_000)).toBe(true);
    expect(verifyWebhookSignature(previous, header, body, 1_700_000_000)).toBe(true);
    expect(verifyWebhookSignature(other, header, body, 1_700_000_000)).toBe(false);
  });

  test("without a previous secret the header is exactly what it was: one signature", () => {
    expect(signWebhook(current, 1_700_000_000, body)).toBe(signWebhook(current, 1_700_000_000, body, undefined));
    expect(signWebhook(current, 1_700_000_000, body).split(",")).toHaveLength(2);
  });

  test("a previous secret that is too short is refused, as the current one is", () => {
    expect(() => signWebhook(current, 1, body, new Uint8Array(31))).toThrow(/at least 32 bytes/);
  });

  test("a changed body fails for both secrets", () => {
    const header = signWebhook(current, 1_700_000_000, body, previous);
    for (const s of [current, previous]) expect(verifyWebhookSignature(s, header, `${body} `, 1_700_000_000)).toBe(false);
  });
});

describe("previousSecretActive", () => {
  const rotated = new Date("2030-01-01T10:00:00Z");
  const at = (ms: number) => new Date(rotated.getTime() + ms);

  test("is 24 hours: active one millisecond before it ends, and not at the moment it ends or after", () => {
    expect(SECRET_OVERLAP_MS).toBe(24 * 3_600_000);
    expect(previousSecretActive(2, rotated, at(0))).toBe(true);
    expect(previousSecretActive(2, rotated, at(SECRET_OVERLAP_MS - 1))).toBe(true);
    expect(previousSecretActive(2, rotated, at(SECRET_OVERLAP_MS))).toBe(false);
    expect(previousSecretActive(2, rotated, at(SECRET_OVERLAP_MS + 1))).toBe(false);
  });

  test("is not active when there was no rotation that left the old secret working, or the secret is still the first", () => {
    expect(previousSecretActive(3, null, at(0))).toBe(false);
    expect(previousSecretActive(1, rotated, at(0))).toBe(false);
  });
});

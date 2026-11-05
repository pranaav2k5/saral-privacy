import { generateKeyPairSync } from "node:crypto";
import { SignJWT, importPKCS8, jwtVerify, importJWK, type JWK } from "jose";
import {
  ReceiptError,
  ReceiptVerificationError,
  buildJwks,
  buildReceiptClaims,
  createLocalSigner,
  signReceipt,
  verifyReceipt,
  type KantaraReceiptClaims,
} from "./index";
import { b64u, forge, hs256, publicJwkOf, rsaKey, validInput } from "./test-helpers";

const NOW = new Date("2026-11-06T09:30:05.000Z");
const claims = (): KantaraReceiptClaims => buildReceiptClaims(validInput(), NOW);

async function setup() {
  const { signer, publicJwk } = await createLocalSigner();
  return { signer, publicJwk, jwks: buildJwks([publicJwk]) };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ReceiptVerificationError) return e.code;
    throw e;
  }
  return "accepted";
}

describe("sign and verify", () => {
  test("round trip returns the same claims; header is RS256/JWT with the kid", async () => {
    const { signer, jwks } = await setup();
    const jwt = await signReceipt(claims(), signer);
    expect(await verifyReceipt(jwt, jwks)).toEqual(claims());
    const header = JSON.parse(Buffer.from(jwt.split(".")[0] as string, "base64url").toString()) as unknown;
    expect(header).toEqual({ alg: "RS256", typ: "JWT", kid: signer.kid });
  });

  test("signing refuses invalid claims", async () => {
    const { signer } = await setup();
    await expect(signReceipt({ ...claims(), policyUrl: "" }, signer)).rejects.toThrow(ReceiptError);
  });

  test("a JWKS with several keys verifies receipts from each (rotation)", async () => {
    const a = await setup();
    const b = await setup();
    const jwks = buildJwks([a.publicJwk, b.publicJwk]);
    expect(await codeOf(verifyReceipt(await signReceipt(claims(), a.signer), jwks))).toBe("accepted");
    expect(await codeOf(verifyReceipt(await signReceipt(claims(), b.signer), jwks))).toBe("accepted");
  });

  test("interop: jose accepts a receipt we signed", async () => {
    const { signer, publicJwk } = await setup();
    const jwt = await signReceipt(claims(), signer);
    const key = await importJWK(publicJwk as unknown as JWK, "RS256");
    const { payload, protectedHeader } = await jwtVerify(jwt, key, { algorithms: ["RS256"] });
    expect(payload.consentReceiptID).toBe(claims().consentReceiptID);
    expect(protectedHeader.kid).toBe(signer.kid);
  });

  test("interop: we accept a receipt that jose signed", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
    const jwk = { ...publicJwkOf(privateKey), kid: "jose-key", alg: "RS256" as const, use: "sig" as const };
    const jwt = await new SignJWT({ ...claims() } as unknown as Record<string, unknown>)
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "jose-key" })
      .sign(await importPKCS8(pem, "RS256"));
    expect(await verifyReceipt(jwt, buildJwks([jwk]))).toEqual(claims());
  });
});

describe("rejections", () => {
  test("a tampered payload fails the signature", async () => {
    const { signer, jwks } = await setup();
    const [h, , s] = (await signReceipt(claims(), signer)).split(".");
    const forgedPayload = b64u(JSON.stringify({ ...claims(), consentTimestamp: 1 }));
    expect(await codeOf(verifyReceipt(`${h}.${forgedPayload}.${s}`, jwks))).toBe("bad_signature");
  });

  test("a tampered header (kid swapped to another listed key) fails the signature", async () => {
    const a = await setup();
    const b = await setup();
    const jwks = buildJwks([a.publicJwk, b.publicJwk]);
    const [, p, s] = (await signReceipt(claims(), a.signer)).split(".");
    const header = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: b.signer.kid }));
    expect(await codeOf(verifyReceipt(`${header}.${p}.${s}`, jwks))).toBe("bad_signature");
  });

  test("alg none is rejected", async () => {
    const { signer, jwks } = await setup();
    expect(await codeOf(verifyReceipt(forge({ alg: "none", kid: signer.kid }, claims()), jwks))).toBe("bad_alg");
  });

  test("HS256 signed with the public key bytes is rejected (algorithm confusion)", async () => {
    const { signer, publicJwk, jwks } = await setup();
    const token = hs256({ alg: "HS256", typ: "JWT", kid: signer.kid }, claims(), publicJwk.n);
    expect(await codeOf(verifyReceipt(token, jwks))).toBe("bad_alg");
  });

  test.each(["rs256", "RS384", "PS256", "ES256", ""])("alg %p is rejected", async (alg) => {
    const { signer, jwks } = await setup();
    expect(await codeOf(verifyReceipt(forge({ alg, kid: signer.kid }, claims(), { signature: "AAAA" }), jwks))).toBe(
      "bad_alg",
    );
  });

  test("an unknown kid and a missing kid are rejected", async () => {
    const { jwks } = await setup();
    const { privateKey } = rsaKey();
    expect(await codeOf(verifyReceipt(forge({ alg: "RS256", kid: "nope" }, claims(), { privateKey }), jwks))).toBe(
      "unknown_kid",
    );
    expect(await codeOf(verifyReceipt(forge({ alg: "RS256" }, claims(), { privateKey }), jwks))).toBe("unknown_kid");
  });

  test("a key under 2048 bits is rejected even with a valid signature", async () => {
    const { privateKey } = rsaKey(1024);
    const weak = { ...publicJwkOf(privateKey), kid: "weak", alg: "RS256" as const, use: "sig" as const };
    const jwt = forge({ alg: "RS256", typ: "JWT", kid: "weak" }, claims(), { privateKey });
    expect(await codeOf(verifyReceipt(jwt, { keys: [weak] }))).toBe("weak_key");
  });

  test("a JWKS entry that is not usable for RS256 signatures is rejected", async () => {
    const { signer, publicJwk } = await setup();
    const jwt = await signReceipt(claims(), signer);
    expect(await codeOf(verifyReceipt(jwt, { keys: [{ ...publicJwk, use: "enc" } as never] }))).toBe("bad_key");
    expect(await codeOf(verifyReceipt(jwt, { keys: [{ ...publicJwk, alg: "RS384" } as never] }))).toBe("bad_key");
    expect(await codeOf(verifyReceipt(jwt, { keys: [{ ...publicJwk, kty: "EC" } as never] }))).toBe("bad_key");
    expect(await codeOf(verifyReceipt(jwt, { keys: [{ ...publicJwk, e: "Aw" } as never] }))).toBe("weak_key");
  });

  test.each([
    ["two parts", "aaa.bbb"],
    ["four parts", "a.b.c.d"],
    ["empty string", ""],
    ["non base64url characters", "a+b/.c=d.e f"],
    ["header that is not JSON", `${b64u("not json")}.${b64u("{}")}.AAAA`],
    ["header that is a JSON array", `${b64u("[]")}.${b64u("{}")}.AAAA`],
    ["header that is a JSON number", `${b64u("7")}.${b64u("{}")}.AAAA`],
  ])("malformed token: %s", async (_name, token) => {
    const { jwks } = await setup();
    expect(await codeOf(verifyReceipt(token, jwks))).toBe("malformed");
  });

  test("a token over 16 KiB is rejected before any parsing", async () => {
    const { signer, jwks } = await setup();
    const big = forge({ alg: "RS256", kid: signer.kid }, { padding: "x".repeat(20000) }, { signature: "AAAA" });
    expect(await codeOf(verifyReceipt(big, jwks))).toBe("malformed");
  });

  test("a valid signature over claims missing a required field is bad_claims", async () => {
    const { signer, jwks } = await setup();
    const rest: Partial<KantaraReceiptClaims> = claims();
    delete rest.policyUrl;
    const header = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: signer.kid }));
    const payload = b64u(JSON.stringify(rest));
    const sig = Buffer.from(await signer.sign(Buffer.from(`${header}.${payload}`))).toString("base64url");
    expect(await codeOf(verifyReceipt(`${header}.${payload}.${sig}`, jwks))).toBe("bad_claims");
  });

  test("a signature with trailing junk or non-canonical base64url is rejected", async () => {
    const { signer, jwks } = await setup();
    const jwt = await signReceipt(claims(), signer);
    expect(await codeOf(verifyReceipt(`${jwt}AA`, jwks))).not.toBe("accepted");
    expect(await codeOf(verifyReceipt(`${jwt}=`, jwks))).toBe("malformed");
  });
});

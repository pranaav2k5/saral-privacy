import { createHash } from "node:crypto";
import { buildJwks, createLocalSigner } from "./index";
import { publicJwkOf, rsaKey } from "./test-helpers";

describe("createLocalSigner", () => {
  test("kid is the RFC 7638 thumbprint of the public key", async () => {
    const { publicJwk } = await createLocalSigner();
    const { e, n } = publicJwk;
    const thumb = createHash("sha256").update(JSON.stringify({ e, kty: "RSA", n })).digest("base64url");
    expect(publicJwk.kid).toBe(thumb);
    expect(publicJwk).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
  });

  test("two signers get different kids; the signer reports its kid", async () => {
    const a = await createLocalSigner();
    const b = await createLocalSigner();
    expect(a.publicJwk.kid).not.toBe(b.publicJwk.kid);
    expect(a.signer.kid).toBe(a.publicJwk.kid);
  });

  test("refuses modulus lengths below 2048", async () => {
    await expect(createLocalSigner({ modulusLength: 1024 as 2048 })).rejects.toThrow(/2048/);
  });
});

describe("buildJwks", () => {
  test("wraps public keys and exposes no private members", async () => {
    const { publicJwk } = await createLocalSigner();
    const jwks = buildJwks([publicJwk]);
    expect(Object.keys(jwks)).toEqual(["keys"]);
    const text = JSON.stringify(jwks);
    for (const member of ["d", "p", "q", "dp", "dq", "qi", "oth", "k"]) {
      expect(Object.keys(jwks.keys[0] as object)).not.toContain(member);
      expect(text).not.toContain(`"${member}":`);
    }
  });

  test("throws when given a JWK that carries private members", async () => {
    const { privateKey } = rsaKey();
    const privateJwk = { ...privateKey.export({ format: "jwk" }), kid: "x", alg: "RS256", use: "sig" };
    expect(() => buildJwks([privateJwk as never])).toThrow(/private/);
  });

  test("throws on duplicate kids and on non-RSA keys", async () => {
    const { publicJwk } = await createLocalSigner();
    expect(() => buildJwks([publicJwk, publicJwk])).toThrow(/duplicate/);
    expect(() => buildJwks([{ ...publicJwk, kty: "EC" } as never])).toThrow(/RSA/);
  });

  test("copies only the allowed members (drops extras)", async () => {
    const { publicJwk } = await createLocalSigner();
    const jwks = buildJwks([{ ...publicJwk, x5c: ["zzz"], custom: 1 } as never]);
    expect(Object.keys(jwks.keys[0] as object).sort()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
  });

  test("publicJwkOf helper matches the signer's modulus", async () => {
    const { privateKey } = rsaKey();
    expect(publicJwkOf(privateKey).kty).toBe("RSA");
  });
});

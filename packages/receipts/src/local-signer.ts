import { createHash, generateKeyPair, sign } from "node:crypto";
import { promisify } from "node:util";
import type { JwkPublic } from "./jwks";
import type { ReceiptSigner } from "./jwt";

const generate = promisify(generateKeyPair);

/** RFC 7638 JWK thumbprint of an RSA public key, base64url. Used as the `kid`. */
export function jwkThumbprint(jwk: { e: string; n: string }): string {
  return createHash("sha256").update(JSON.stringify({ e: jwk.e, kty: "RSA", n: jwk.n })).digest("base64url");
}

/**
 * Development and test signer: the key lives in memory and is gone when the process ends.
 * Production signs with a KMS key through the same `ReceiptSigner` interface.
 */
export async function createLocalSigner(
  opts: { modulusLength?: 2048 | 3072 | 4096 } = {},
): Promise<{ signer: ReceiptSigner; publicJwk: JwkPublic }> {
  const modulusLength = opts.modulusLength ?? 2048;
  if (![2048, 3072, 4096].includes(modulusLength)) throw new Error("modulusLength must be at least 2048");
  const { privateKey, publicKey } = await generate("rsa", { modulusLength });
  const jwk = publicKey.export({ format: "jwk" });
  const n = jwk.n as string;
  const e = jwk.e as string;
  const kid = jwkThumbprint({ e, n });
  return {
    signer: {
      kid,
      sign: (input) => Promise.resolve(sign("RSA-SHA256", input, privateKey)),
    },
    publicJwk: { kty: "RSA", n, e, kid, alg: "RS256", use: "sig" },
  };
}

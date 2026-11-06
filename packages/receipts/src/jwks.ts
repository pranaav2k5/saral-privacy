export interface JwkPublic {
  kty: "RSA";
  n: string;
  e: string;
  kid: string;
  alg: "RS256";
  use: "sig";
}

const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

/** The public key set served at `/.well-known/jwks.json`. Refuses private key material. */
export function buildJwks(keys: readonly JwkPublic[]): { keys: JwkPublic[] } {
  const seen = new Set<string>();
  const out: JwkPublic[] = [];
  for (const k of keys) {
    const raw = k as unknown as Record<string, unknown>;
    if (PRIVATE_MEMBERS.some((m) => m in raw)) throw new Error("JWK contains private key members");
    if (k.kty !== "RSA") throw new Error("only RSA keys are supported");
    if (typeof k.kid !== "string" || k.kid === "") throw new Error("every key needs a kid");
    if (seen.has(k.kid)) throw new Error(`duplicate kid ${k.kid}`);
    seen.add(k.kid);
    out.push({ kty: "RSA", n: k.n, e: k.e, kid: k.kid, alg: "RS256", use: "sig" });
  }
  return { keys: out };
}

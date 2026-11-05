import { Controller, Get, Header, Inject } from "@nestjs/common";
import { Public } from "../auth/access.js";
import { KEY_PROVIDER, type KeyProvider } from "../keys/key-provider.js";

@Controller(".well-known")
export class JwksController {
  constructor(@Inject(KEY_PROVIDER) private readonly keys: KeyProvider) {}

  /** The public keys that verify receipts. Public members only. */
  @Get("jwks.json")
  @Public()
  @Header("Cache-Control", "public, max-age=300")
  jwks() {
    return this.keys.jwks();
  }
}

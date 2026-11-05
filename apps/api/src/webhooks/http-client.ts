import type { lookup as dnsLookup } from "node:dns";
import { request } from "node:https";
import type { WebhookHttp, WebhookRequest } from "./tokens.js";
import { guardedLookup, type Resolver } from "./url-guard.js";

const TIMEOUT_MS = 10_000;

/**
 * The real client: https only, a 10 second overall deadline, redirects are not followed (a 3xx is a failure), the response
 * body is discarded, and the address is checked again when the connection is made.
 */
export interface HttpsClientOptions {
  resolver?: Resolver;
  timeoutMs?: number;
  /** Test seam: replaces the guarded lookup so a test can reach a local server. Production never sets it. */
  lookup?: typeof dnsLookup;
  /** Test seam: a certificate authority to trust (a self-signed test certificate). Production never sets it. */
  ca?: string | Buffer;
}

export function createHttpsClient(options: HttpsClientOptions = {}): WebhookHttp {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const lookup = options.lookup ?? guardedLookup(options.resolver);
  return {
    post: ({ url, headers, body }: WebhookRequest) =>
      new Promise((resolve, reject) => {
        let settled = false;
        const settle = <T>(fn: (value: T) => void) => (value: T) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          fn(value);
        };
        const req = request(
          url,
          { method: "POST", headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) }, lookup, timeout: timeoutMs, ...(options.ca ? { ca: options.ca } : {}) },
          (res) => {
            const status = res.statusCode ?? 0;
            // The status is all that is wanted. Dropping the body and the connection frees the worker at once.
            res.destroy();
            settle(resolve)({ status });
          },
        );
        // `timeout` above is an idle timer: a server that sends one byte every few seconds never trips it. This wall-clock
        // deadline covers the whole exchange (name lookup, connect, TLS, request, response headers).
        const deadline = setTimeout(() => req.destroy(new Error(`timed out after ${String(timeoutMs)} ms`)), timeoutMs);
        req.on("timeout", () => req.destroy(new Error(`timed out after ${String(timeoutMs)} ms`)));
        req.on("error", settle(reject));
        req.end(body);
      }),
  };
}

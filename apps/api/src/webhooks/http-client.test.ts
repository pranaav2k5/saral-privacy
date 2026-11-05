import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { createServer as createTlsServer } from "node:tls";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpsClient } from "./http-client.js";
import { guardedLookup } from "./url-guard.js";

let dir: string;
let cert: string;
let key: string;
let server: Server;
let port: number;
let seen: { method?: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];
let handler: (res: import("node:http").ServerResponse) => void = (res) => res.writeHead(200).end("ok");

// A throwaway self-signed certificate for localhost, made with the openssl command line.
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "saral-tls-"));
  const r = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`);
  cert = readFileSync(join(dir, "c.pem"), "utf8");
  key = readFileSync(join(dir, "k.pem"), "utf8");
  server = createServer({ key, cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      handler(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  seen = [];
  handler = (res) => res.writeHead(200).end("ok");
});

// Node asks for every address (`all: true`) when connecting, so the test lookup must answer in that shape too.
const toLoopback = ((_host: string, opts: { all?: boolean }, cb: (e: Error | null, a: unknown, f?: number) => void) =>
  opts.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)) as never;
const client = (timeoutMs = 2000) => createHttpsClient({ lookup: toLoopback, ca: cert, timeoutMs });
const url = () => `https://localhost:${String(port)}/hook`;

describe("createHttpsClient", () => {
  test("posts the body and headers as given and reports the status", async () => {
    const body = '{"hello":"wörld"}';
    const res = await client().post({ url: url(), headers: { "Content-Type": "application/json", "X-Test": "1" }, body });
    expect(res).toEqual({ status: 200 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.body).toBe(body);
    expect(seen[0]?.headers["x-test"]).toBe("1");
    expect(seen[0]?.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
  });

  test("reports non-2xx statuses without throwing", async () => {
    handler = (res) => res.writeHead(503).end();
    expect(await client().post({ url: url(), headers: {}, body: "{}" })).toEqual({ status: 503 });
  });

  test("does not follow a redirect: it reports the 302 and makes one request", async () => {
    handler = (res) => res.writeHead(302, { Location: "https://169.254.169.254/latest/meta-data" }).end();
    expect(await client().post({ url: url(), headers: {}, body: "{}" })).toEqual({ status: 302 });
    expect(seen).toHaveLength(1);
  });

  test("gives up on a server that does not answer", async () => {
    handler = () => undefined; // never respond
    await expect(client(300).post({ url: url(), headers: {}, body: "{}" })).rejects.toThrow(/timed out/);
  });

  test("gives up after the overall deadline even when the server keeps sending a trickle of bytes (idle timers never fire)", async () => {
    const drip = createTlsServer({ key, cert }, (socket) => {
      socket.once("data", () => {
        // A status line sent one byte at a time: the connection is never idle, and the response never completes.
        const bytes = Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n");
        let i = 0;
        const timer = setInterval(() => {
          if (i < bytes.length && !socket.destroyed) socket.write(bytes.subarray(i++, i));
          else clearInterval(timer);
        }, 40);
        socket.on("close", () => clearInterval(timer));
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => drip.listen(0, "127.0.0.1", resolve));
    const dripPort = (drip.address() as AddressInfo).port;
    const started = Date.now();
    try {
      // The idle timeout is far longer than the gaps between bytes; only an overall deadline can stop this.
      await expect(createHttpsClient({ lookup: toLoopback, ca: cert, timeoutMs: 400 }).post({ url: `https://localhost:${String(dripPort)}/x`, headers: {}, body: "{}" })).rejects.toThrow(/timed out/);
    } finally {
      await new Promise((resolve) => drip.close(resolve));
    }
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test("does not hang on a large response body", async () => {
    handler = (res) => res.writeHead(200).end("x".repeat(5_000_000));
    expect(await client().post({ url: url(), headers: {}, body: "{}" })).toEqual({ status: 200 });
  });

  test("rejects a connection that is refused", async () => {
    await expect(createHttpsClient({ lookup: toLoopback, timeoutMs: 1000 }).post({ url: "https://localhost:1/x", headers: {}, body: "{}" })).rejects.toThrow();
  });

  test("rejects a certificate it does not trust", async () => {
    await expect(createHttpsClient({ lookup: toLoopback, timeoutMs: 1000 }).post({ url: url(), headers: {}, body: "{}" })).rejects.toThrow(/self[- ]signed|certificate/i);
  });

  test("the default client refuses to connect to a private address even though the server is reachable", async () => {
    await expect(createHttpsClient({ ca: cert, timeoutMs: 1000 }).post({ url: url(), headers: {}, body: "{}" })).rejects.toThrow(/private or reserved/);
    expect(seen).toHaveLength(0);
  });
});

describe("guardedLookup", () => {
  const run = (resolver: () => Promise<string[]>, options: unknown = {}) =>
    new Promise<{ err: Error | null; address?: unknown; family?: number }>((resolve) => {
      (guardedLookup(resolver) as unknown as (h: string, o: unknown, cb: (err: Error | null, address?: unknown, family?: number) => void) => void)(
        "h.example.org", options, (err, address, family) => resolve({ err, address, family }),
      );
    });

  test("returns the first address when every answer is public", async () => {
    expect(await run(async () => ["93.184.216.34", "2606:4700::1111"])).toEqual({ err: null, address: "93.184.216.34", family: 4 });
  });

  test("returns every address when asked for all", async () => {
    const r = await run(async () => ["93.184.216.34", "2606:4700::1111"], { all: true });
    expect(r.address).toEqual([{ address: "93.184.216.34", family: 4 }, { address: "2606:4700::1111", family: 6 }]);
  });

  test.each([["10.0.0.5"], ["127.0.0.1"], ["169.254.169.254"], ["::1"], ["93.184.216.34", "10.0.0.5"], []])("refuses the answer %p", async (...addresses) => {
    const r = await run(async () => addresses as string[]);
    expect(r.err?.message).toMatch(/private or reserved/);
  });

  test("passes a resolver failure on", async () => {
    const r = await run(async () => {
      throw new Error("ENOTFOUND");
    });
    expect(r.err?.message).toBe("ENOTFOUND");
  });
});

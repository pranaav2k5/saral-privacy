import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

// Runs the built entry point (`pnpm test` builds first) so the startup wiring is covered.
const apiDir = fileURLToPath(new URL("..", import.meta.url));

function startApi(env: Record<string, string>) {
  return spawn(process.execPath, ["dist/main.js"], {
    cwd: apiDir,
    env: { ...process.env, ...env },
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForHealthz(port: number): Promise<Response> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await fetch(`http://127.0.0.1:${port}/healthz`);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`api did not start listening on port ${port}`);
}

describe("node dist/main.js", () => {
  test("exits 1 and names PORT when PORT is invalid", async () => {
    const child = startApi({ PORT: "abc" });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    const [code] = await once(child, "exit");

    expect(code).toBe(1);
    expect(stderr).toMatch(/PORT/);
  });

  test("listens on the PORT from the environment", async () => {
    const port = await freePort();
    const child = startApi({ PORT: String(port) });
    try {
      const response = await waitForHealthz(port);
      expect(response.status).toBe(200);
    } finally {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import pkg from "../package.json";

test("IIFE bundle exposes SaralPrivacy.version as a browser global", () => {
  const code = readFileSync(join(__dirname, "../dist/saral-privacy.global.js"), "utf8");
  const sandbox: { SaralPrivacy?: { version: string } } = {};
  runInNewContext(code, sandbox);
  expect(sandbox.SaralPrivacy?.version).toBe(pkg.version);
});

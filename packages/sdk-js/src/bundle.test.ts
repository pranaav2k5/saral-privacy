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

test("the IIFE loads without a DOM (server-side rendering safe) and exposes init", () => {
  const code = readFileSync(join(__dirname, "../dist/saral-privacy.global.js"), "utf8");
  const sandbox: { SaralPrivacy?: { init: unknown } } = {};
  expect(() => runInNewContext(code, sandbox)).not.toThrow();
  expect(typeof sandbox.SaralPrivacy?.init).toBe("function");
});

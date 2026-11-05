import pkg from "../package.json";
import { version } from "./index";

test("sdk version matches package.json", () => {
  expect(version).toBe(pkg.version);
});

test("sdk version is a semver string", () => {
  expect(version).toMatch(/^\d+\.\d+\.\d+/);
});

const nextJest = require("next/jest.js");

const createJestConfig = nextJest({ dir: "./" });

module.exports = createJestConfig({
  testEnvironment: "jsdom",
  setupFiles: ["<rootDir>/jest.setup.cjs"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    // Test against the sibling package's source so a stale dist can never be tested by mistake.
    "^@saral/notice$": "<rootDir>/../../packages/notice/src/index.ts",
  },
  testMatch: ["<rootDir>/src/**/*.test.{ts,tsx}"],
});

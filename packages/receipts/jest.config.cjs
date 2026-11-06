module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/**/*.test.ts"],
  // Test against the sibling package's source so a stale dist can never be tested by mistake.
  moduleNameMapper: { "^@saral/schemas$": "<rootDir>/../schemas/src/index.ts" },
};

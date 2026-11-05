// NestJS 12 is ESM-only, so Jest runs in ESM mode (needs NODE_OPTIONS=--experimental-vm-modules).
module.exports = {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/**/*.test.ts", "<rootDir>/test/**/*.test.ts"],
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
  transform: { "^.+\\.ts$": ["ts-jest", { useESM: true }] },
};

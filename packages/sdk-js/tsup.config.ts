import { defineConfig } from "tsup";

// IIFE for <script> tags (budgeted in .size-limit.json), ESM and CJS for npm consumers.
export default defineConfig({
  entry: { "saral-privacy": "src/index.ts" },
  format: ["iife", "esm", "cjs"],
  globalName: "SaralPrivacy",
  minify: true,
  dts: true,
  clean: true,
  target: "es2020",
});

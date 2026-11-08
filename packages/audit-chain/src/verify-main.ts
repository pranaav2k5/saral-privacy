#!/usr/bin/env node
import { runVerifier } from "./verify-cli";

void runVerifier(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) }).then((code) => {
  process.exitCode = code;
});

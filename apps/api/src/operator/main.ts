import { runOperator } from "./cli.js";

process.exitCode = await runOperator(process.argv.slice(2), process.env, {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
});

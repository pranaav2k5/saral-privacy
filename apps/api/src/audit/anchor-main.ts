import { runAnchor } from "./anchor-cli.js";

process.exitCode = await runAnchor(process.argv.slice(2), process.env, {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
});

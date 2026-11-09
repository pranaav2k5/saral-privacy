import { runReminders } from "./reminders-cli.js";

process.exitCode = await runReminders(process.argv.slice(2), process.env, {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
});

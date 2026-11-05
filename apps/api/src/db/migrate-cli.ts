import pg from "pg";
import { migrate } from "./migrate.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  const applied = await migrate(client);
  console.log(applied.length > 0 ? `applied: ${applied.join(", ")}` : "database is up to date");
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await client.end();
}

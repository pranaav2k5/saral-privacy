import "reflect-metadata";
import { createApp } from "./bootstrap.js";
import { loadConfig, type AppConfig } from "./config.js";

async function bootstrap(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  const app = await createApp(config.trustProxy === undefined ? {} : { trustProxy: config.trustProxy });
  await app.listen(config.port);
}

void bootstrap();

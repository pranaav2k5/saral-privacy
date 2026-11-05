import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { loadConfig, type AppConfig } from "./config.js";

async function bootstrap(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  const app = await NestFactory.create(AppModule);
  await app.listen(config.port);
}

void bootstrap();

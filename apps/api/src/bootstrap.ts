import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

/**
 * Builds the application with shutdown hooks on. As PID 1 in a container, Node ignores
 * SIGTERM unless a handler is registered, so `docker stop` would otherwise wait for SIGKILL.
 */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  return app;
}
